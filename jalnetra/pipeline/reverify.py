"""Re-check open river_flood incidents against the newest Sentinel-1 pass and attach the result as evidence.
Compares the share of land under new water within 2 km of each incident at the detection pass vs the latest pass.
Usage: JALNETRA_KEY=... python reverify.py  (run from the pipeline folder that holds o2.npz / o3.npz / grid.py)"""
import json, os, sys, urllib.request
import numpy as np
sys.path.insert(0, os.environ.get('GEO_DIR', '.'))
from grid import W, N, RES, WIDTH, HEIGHT
API = os.environ.get('JALNETRA_API', 'https://oceaylrebzflgyxfjqfb.supabase.co/functions/v1/jalnetra-api')
KEY = os.environ['JALNETRA_KEY']
G = os.environ.get('GEO_DIR', '.')
def call(path, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body else None, method='POST' if body else 'GET', headers={'content-type': 'application/json', 'x-jalnetra-key': KEY})
    return json.load(urllib.request.urlopen(req, timeout=30))
meta = json.load(open(os.path.join(G, 's1_meta.json')))
first, latest = 'o2', 'o3'
A = np.load(os.path.join(G, f'{first}.npz')); B = np.load(os.path.join(G, f'{latest}.npz'))
r = int(round(0.018 / RES))  # ~2 km
def share(z, lat, lng):
    row, col = int((N - lat) / RES), int((lng - W) / RES)
    sl = (slice(max(row - r, 0), row + r), slice(max(col - r, 0), col + r))
    v = z['valid'][sl]
    return None if v.mean() < 0.5 else float(z['new'][sl][v].mean())
for inc in call('/incidents?type=river_flood&status=detected,approved,ticketed,reopened,escalated,fixed_claimed')['incidents']:
    a, b = share(A, inc['lat'], inc['lng']), share(B, inc['lat'], inc['lng'])
    t1, t2 = meta[first]['flood_time'][:16].replace('T', ' '), meta[latest]['flood_time'][:16].replace('T', ' ')
    if b is None:
        note = f"Re-check: the latest radar pass ({t2} UTC) does not cover this spot. Next pass needed."
    else:
        pct = None if not a else round(100 * (1 - b / a))
        note = (f"Re-check with Sentinel-1 {t2} UTC: new water within 2 km is {b*100:.1f}% of land, "
                f"against {a*100:.1f}% on {t1} UTC" + (f" ({pct}% less)." if pct is not None and pct >= 0 else f" ({-pct}% more)." if pct is not None else "."))
    call(f"/incidents/{inc['id']}/evidence", {'note': note, 'data': {'pass_first': meta[first]['flood_time'], 'pass_latest': meta[latest]['flood_time'], 'share_first': a, 'share_latest': b}})
    print(inc['title'], '->', note)
