import numpy as np, rasterio, warnings, json
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from scipy.ndimage import median_filter
import planetary_computer as pc
from pystac_client import Client
from grid import *
warnings.filterwarnings('ignore')
cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
def mosaic(date, orbit):
    its = [i for i in cat.search(collections=['sentinel-1-rtc'], bbox=[W,S,E,N], datetime=f'{date}/{date}').items() if i.properties['sat:relative_orbit'] == orbit]
    acc = np.full((HEIGHT, WIDTH), np.nan, np.float32); times = []
    for it in its:
        with rasterio.open(it.assets['vv'].href) as src:
            with WarpedVRT(src, crs='EPSG:4326', transform=TR, width=WIDTH, height=HEIGHT, resampling=Resampling.average, src_nodata=0, nodata=np.nan, dtype='float32') as vrt:
                a = vrt.read(1)
        a[a <= 0] = np.nan
        m = np.isnan(acc) & np.isfinite(a); acc[m] = a[m]; times.append(it.properties['datetime'])
    db = 10*np.log10(acc)
    return median_filter(np.nan_to_num(db, nan=0), size=3), np.isfinite(db), sorted(times)
pairs = {'o1': ('2026-09-26', '2026-09-14', 158), 'o2': ('2026-09-29', '2026-09-17', 19), 'o3': ('2026-10-03', '2026-09-21', 85)}
meta = {}
for k, (fd, bd, orb) in pairs.items():
    f, fv, ft = mosaic(fd, orb); b, bv, bt = mosaic(bd, orb)
    valid = fv & bv
    new = valid & (f < -18) & (b >= -18) & ((f - b) < -3)
    perm = valid & (b < -18)
    np.savez_compressed(f'{k}.npz', new=new, perm=perm, valid=valid)
    px = (RES*111.32)*(RES*111.32*np.cos(np.deg2rad(26.7)))  # km2 per pixel (approx at mid-lat)
    meta[k] = {'flood_time': ft[0], 'base_time': bt[0], 'orbit': orb, 'new_km2': round(float(new.sum()*px), 1), 'perm_km2': round(float(perm.sum()*px), 1), 'coverage': round(float(valid.mean()), 3)}
    print(k, meta[k], flush=True)
json.dump(meta, open('s1_meta.json', 'w'), indent=1)
