import json, math, sys, warnings, numpy as np, rasterio, planetary_computer as pc
from rasterio.windows import from_bounds
from rasterio.warp import transform_bounds
from pyproj import Transformer
from pystac_client import Client
warnings.filterwarnings('ignore')
cfg = json.load(open(sys.argv[1]))   # {start, flood_dates, win, glofas, villages, out, base_gap}
cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
G = json.load(open(cfg['glofas']))['stations']
V = json.load(open(cfg['villages']))
t0 = np.datetime64(cfg['start'])
D = lambda s: int((np.datetime64(s[:10]) - t0).astype(int))
peak = [cfg['pk0'] + int(np.argmax(s['q'][cfg['pk0']:cfg['pk1']])) for s in G]
def hav(a, b):
    r = math.pi/180; dl = (b[0]-a[0])*r; dn = (b[1]-a[1])*r
    h = math.sin(dl/2)**2 + math.cos(a[0]*r)*math.cos(b[0]*r)*math.sin(dn/2)**2
    return 12742*math.asin(math.sqrt(h))
def tile(la, lo):
    n = math.floor(la); e = math.floor(lo); t = f'Copernicus_DSM_COG_10_N{n:02d}_00_E{e:03d}_00_DEM'
    return f'https://copernicus-dem-30m.s3.amazonaws.com/{t}/{t}.tif'
import threading
_tl = threading.local()
def dem(la, lo):
    c = getattr(_tl, 'c', None)
    if c is None: c = _tl.c = {}
    u = tile(la, lo); ds = c.get(u) or rasterio.open(u); c[u] = ds; return ds
def read(item, la, lo, half):
    with rasterio.open(item.assets['vv'].href) as ds:
        b = transform_bounds('EPSG:4326', ds.crs, lo-half, la-half, lo+half, la+half)
        w = from_bounds(*b, ds.transform); a = ds.read(1, window=w).astype('float32'); tr = ds.window_transform(w)
    a[a <= 0] = np.nan; return 10*np.log10(a), tr, ds.crs
out = []
def one(v):
    la, lo = v['lat'], v['lng']
    v['si'] = int(np.argmin([hav([la, lo], [s['lat'], s['lng']]) for s in G]))
    its = list(cat.search(collections=['sentinel-1-rtc'], intersects={'type':'Point','coordinates':[lo, la]}, datetime=cfg['search']).items())
    fl = sorted([i for i in its if i.properties['datetime'][:10] in cfg['flood_dates']], key=lambda i: abs(D(i.properties['datetime']) - peak[v['si']]))
    for fi in fl:
        fd = D(fi.properties['datetime'])
        base = [i for i in its if i.properties.get('sat:relative_orbit') == fi.properties.get('sat:relative_orbit') and i.properties.get('sat:orbit_state') == fi.properties.get('sat:orbit_state') and D(i.properties['datetime']) <= fd - cfg['base_gap']]
        if not base: continue
        bi = sorted(base, key=lambda i: -D(i.properties['datetime']))[0]
        try:
            f, _, _ = read(fi, la, lo, 0.02); b, tr, crs = read(bi, la, lo, 0.03)
        except Exception as e:
            print('ERR', v['name'], e); continue
        # central 0.04 deg of the base window matches flood window size
        h_, w_ = f.shape; bh, bw = b.shape; cy, cx = bh//2, bw//2
        bc = b[cy-h_//2:cy-h_//2+h_, cx-w_//2:cx-w_//2+w_]
        if bc.shape != f.shape: continue
        valid = np.isfinite(f) & np.isfinite(bc)
        if valid.sum() < 1000: continue
        r = min(h_, w_)//2; ch, cw = h_//2, w_//2
        sl = (slice(ch-r, ch+r), slice(cw-r, cw+r))
        ff, bb, vv = f[sl], bc[sl], valid[sl]
        nw = float(((ff < -18) & ~(bb < -18) & vv).sum() / vv.sum())
        wm = b < -18; rows, cols = np.where(wm)
        if len(rows) < 30: continue
        xs, ys = rasterio.transform.xy(tr, rows, cols)
        lon, lat = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True).transform(np.array(xs), np.array(ys))
        d = np.hypot((lon-lo)*111320*math.cos(la*math.pi/180), (lat-la)*110540); k = np.argsort(d)[:60]
        dd = dem(la, lo)
        el = np.array([x[0] for x in dd.sample(list(zip(lon[k], lat[k])))], dtype='float32')
        ev = float(np.nanmedian(np.array([x[0] for x in dd.sample([(lo+dx, la+dy) for dx in (-.0003, 0, .0003) for dy in (-.0003, 0, .0003)])], dtype='float32')))
        r = (dict(id=v['id'], lat=la, lng=lo, name=v['name'], si=v['si'], h=round(ev-float(np.nanmedian(el)), 1), d=round(float(d[k[0]])), nw=round(nw, 3), fd=fi.properties['datetime'][:10], bd=bi.properties['datetime'][:10]))
        print(v['name'], r['fd'], r['h'], round(nw*100, 1), flush=True)
        return r
    print('SKIP', v['name']); return None
from concurrent.futures import ThreadPoolExecutor
with ThreadPoolExecutor(8) as ex:
    out = [r for r in ex.map(one, V) if r]
json.dump(out, open(cfg['out'], 'w'))
obs = np.array([x['nw'] >= 0.03 for x in out]); h = np.array([x['h'] for x in out])
print('n', len(out), 'obs', int(obs.sum()))
if obs.sum() and (~obs).sum():
    print('AUC h', round(np.mean([(a < b) + 0.5*(a == b) for a in h[obs] for b in h[~obs]]), 2))
for r in [2, 3, 4, 5, 6, 7, 8, 10]:
    p = h < r; print(r, 'acc', round((p == obs).mean(), 2), 'caught', int((p & obs).sum()), '/', int(obs.sum()), 'FP', int((p & ~obs).sum()), '/', int((~obs).sum()))
