import numpy as np, rasterio, warnings, json
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.transform import from_origin
import planetary_computer as pc
from pystac_client import Client
warnings.filterwarnings('ignore')
W, S, E, N, RES = 83.1, 25.5, 85.65, 28.45, 0.0006
WIDTH, HEIGHT = int(round((E-W)/RES)), int(round((N-S)/RES)); TR = from_origin(W, N, RES, RES)
cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
items = list(cat.search(collections=['sentinel-2-l2a'], bbox=[W,S,E,N], datetime='2025-11-01/2026-02-28', query={'eo:cloud_cover':{'lt':5}}).items())
by = {}
for it in items: by.setdefault(it.properties['s2:mgrs_tile'], []).append(it)
for k in by: by[k].sort(key=lambda i: i.properties['eo:cloud_cover'])
print(len(items), 'items', len(by), 'tiles', flush=True)
out = np.zeros((HEIGHT, WIDTH, 3), np.float32); filled = np.zeros((HEIGHT, WIDTH), bool); meta = []
order = sorted(by, key=lambda k: by[k][0].properties['eo:cloud_cover'])
def read(it):
    with rasterio.open(it.assets['visual'].href) as src, WarpedVRT(src, crs='EPSG:4326', transform=TR, width=WIDTH, height=HEIGHT, resampling=Resampling.average) as vrt:
        return vrt.read().transpose(1, 2, 0).astype(np.float32)
for rnd in (0, 1):  # second round fills gaps with the next-best scene of each tile
    for t in order:
        if rnd >= len(by[t]): continue
        it = by[t][rnd]
        a = read(it); valid = a.sum(2) > 0
        new = valid & ~filled
        if new.sum() < 1000: continue
        ov = valid & filled
        if ov.sum() > 5000:
            g = np.clip(out[ov].mean(0) / np.maximum(a[ov].mean(0), 1), 0.85, 1.18); a *= g
        out[new] = a[new]; filled |= new
        meta.append({'tile': t, 'date': it.properties['datetime'][:10], 'cloud': it.properties['eo:cloud_cover']})
        print(rnd, t, it.properties['datetime'][:10], round(filled.mean()*100, 1), flush=True)
np.save('s2b.npy', np.clip(out, 0, 255).astype(np.uint8)); json.dump({'bounds': [W, S, E, N], 'scenes': meta}, open('s2b_meta.json', 'w'))
print('done', filled.mean())
