import numpy as np, rasterio, warnings
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from grid import *
warnings.filterwarnings('ignore')
out = np.full((HEIGHT, WIDTH), np.nan, np.float32)
for n in (25, 26, 27):
    for e in (83, 84, 85):
        t = f'Copernicus_DSM_COG_10_N{n:02d}_00_E{e:03d}_00_DEM'
        u = f'https://copernicus-dem-30m.s3.amazonaws.com/{t}/{t}.tif'
        try:
            with rasterio.open(u) as src, WarpedVRT(src, crs='EPSG:4326', transform=TR, width=WIDTH, height=HEIGHT, resampling=Resampling.average, nodata=np.nan, dtype='float32') as vrt:
                a = vrt.read(1)
            m = np.isfinite(a) & np.isnan(out) & (a != 0); out[m] = a[m]; print(t, 'ok', flush=True)
        except Exception as ex: print(t, 'ERR', ex)
np.save('dem.npy', out); print('nan share', np.isnan(out).mean())
