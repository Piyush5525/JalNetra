import numpy as np, rasterio, warnings, json
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.windows import Window
from rasterio.transform import from_origin
import planetary_computer as pc
from shapely.geometry import shape, Point
from shapely.prepared import prep
from pystac_client import Client
warnings.filterwarnings('ignore')
meta = json.load(open('s2b_meta.json')); W, S, E, N = meta['bounds']; RES = 0.0006
out = np.load('s2b.npy').astype(np.float32); H_, W_ = out.shape[:2]; TR = from_origin(W, N, RES, RES)
gap = out.sum(2) == 0
cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
items = list(cat.search(collections=['sentinel-2-l2a'], bbox=[W,S,E,N], datetime='2025-10-15/2026-03-15', query={'eo:cloud_cover':{'lt':12}}).items())
items.sort(key=lambda i: i.properties['eo:cloud_cover'])
print(len(items), 'candidates', gap.mean(), flush=True)
for it in items:
    if gap.mean() < 0.002: break
    x0, y0, x1, y1 = it.bbox
    c0 = max(0, int((x0 - W) / RES)); c1 = min(W_, int((x1 - W) / RES) + 1); r0 = max(0, int((N - y1) / RES)); r1 = min(H_, int((N - y0) / RES) + 1)
    if c1 <= c0 or r1 <= r0: continue
    g = gap[r0:r1, c0:c1]
    if g.sum() < 2000: continue
    fp = prep(shape(it.geometry)); rr, cc = np.where(g[::25, ::25])
    hits = sum(fp.contains(Point(W + (c0 + c*25) * RES, N - (r0 + r*25) * RES)) for r, c in zip(rr, cc))
    if hits < 4: continue
    with rasterio.open(it.assets['visual'].href) as src, WarpedVRT(src, crs='EPSG:4326', transform=TR, width=W_, height=H_, resampling=Resampling.average) as vrt:
        a = vrt.read(window=Window(c0, r0, c1 - c0, r1 - r0)).transpose(1, 2, 0).astype(np.float32)
    valid = a.sum(2) > 0; new = valid & g
    if new.sum() < 2000: continue
    sub = out[r0:r1, c0:c1]; ov = valid & ~g
    if ov.sum() > 5000: a *= np.clip(sub[ov].mean(0) / np.maximum(a[ov].mean(0), 1), 0.85, 1.18)
    sub[new] = a[new]; gap[r0:r1, c0:c1] &= ~new
    meta['scenes'].append({'tile': it.properties['s2:mgrs_tile'], 'date': it.properties['datetime'][:10], 'cloud': it.properties['eo:cloud_cover']})
    print(it.properties['s2:mgrs_tile'], it.properties['datetime'][:10], round(gap.mean() * 100, 2), flush=True)
np.save('s2b.npy', np.clip(out, 0, 255).astype(np.uint8)); json.dump(meta, open('s2b_meta.json', 'w')); print('done', gap.mean())
