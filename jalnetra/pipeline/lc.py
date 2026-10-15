import numpy as np, rasterio, warnings, json
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
import planetary_computer as pc
from pystac_client import Client
from grid import *
warnings.filterwarnings('ignore')
cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
gsw = list(cat.search(collections=['jrc-gsw'], bbox=[W,S,E,N]).items())[0]
with rasterio.open(gsw.assets['occurrence'].href) as src, WarpedVRT(src, crs='EPSG:4326', transform=TR, width=WIDTH, height=HEIGHT, resampling=Resampling.average) as v:
    occ = v.read(1).astype(np.float32)
occ[occ > 100] = 0
np.save('occ.npy', occ.astype(np.uint8)); print('occ done', (occ >= 50).mean(), flush=True)
lc = np.zeros((HEIGHT, WIDTH), np.uint8)
for it in cat.search(collections=['esa-worldcover'], bbox=[W,S,E,N]).items():
    if 'v200' not in it.id: continue
    with rasterio.open(it.assets['map'].href) as src, WarpedVRT(src, crs='EPSG:4326', transform=TR, width=WIDTH, height=HEIGHT, resampling=Resampling.mode) as v:
        a = v.read(1)
    m = (a > 0) & (lc == 0); lc[m] = a[m]; print(it.id, flush=True)
np.save('lc.npy', lc); print('lc classes', np.unique(lc, return_counts=True))
