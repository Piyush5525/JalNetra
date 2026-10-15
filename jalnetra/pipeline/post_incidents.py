"""Post the flood part's real detections to the shared JalNetra incident API.
One river_flood incident per river reach where Sentinel-1 saw new water at villages.
Usage: JALNETRA_KEY=... python post_incidents.py [o2|o3]"""
import json, os, sys, urllib.request
from collections import defaultdict
API = os.environ.get('JALNETRA_API', 'https://oceaylrebzflgyxfjqfb.supabase.co/functions/v1/jalnetra-api')
KEY = os.environ['JALNETRA_KEY']
obs_id = sys.argv[1] if len(sys.argv) > 1 else 'o2'
D = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'src', 'data.json')))
obs = next(o for o in D['obs'] if o['id'] == obs_id)
st = D['river']['stations']
groups = defaultdict(list)
for v in D['villages']:
    d = v['obs'].get(obs_id)
    if d is not None and d <= 0.5: groups[v['si']].append(v)
for si, vs in sorted(groups.items()):
    n = len(vs); lat = sum(v['lat'] for v in vs) / n; lng = sum(v['lng'] for v in vs) / n
    sev = 'high' if n >= 10 else 'medium' if n >= 3 else 'low'
    dists = sorted({v['district'] for v in vs if v['district']})
    body = {
        'incident_type': 'river_flood', 'severity': sev, 'confidence': 0.8, 'lat': round(lat, 5), 'lng': round(lng, 5),
        'observed_at': obs['time'], 'source': 'satellite', 'language': 'hi',
        'title': f"Radar flood near {st[si]['label']}: {n} villages within 500 m of new water",
        'details': {'sensor': 'Sentinel-1 RTC', 'observation': obs['time'], 'baseline': obs['base'], 'reach': st[si]['label'],
                    'villages': [v['name'] for v in vs], 'districts': dists, 'gloFAS_peak_day': st[si]['peakDay'], 'peak_m3s': round(st[si]['peakQ'])},
    }
    req = urllib.request.Request(API + '/incidents', data=json.dumps(body).encode(), method='POST', headers={'content-type': 'application/json', 'x-jalnetra-key': KEY})
    r = json.load(urllib.request.urlopen(req, timeout=30))
    print(('merged ' if r['merged'] else 'created ') + r['incident']['id'], body['title'])
