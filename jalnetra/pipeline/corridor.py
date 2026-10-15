import numpy as np, json
from scipy.ndimage import distance_transform_edt, binary_opening, binary_closing, uniform_filter1d
from grid import *
dem = np.load('dem.npy')
R = json.load(open('river_main.json')); P = np.array(R['path'])
# densify path to ~ pixel spacing
pts = []
for (x0, y0), (x1, y1) in zip(P[:-1], P[1:]):
    n = max(1, int(max(abs(x1-x0), abs(y1-y0)) / RES))
    for k in range(n): pts.append((x0 + (x1-x0)*k/n, y0 + (y1-y0)*k/n))
pts = np.array(pts)
cols = ((pts[:, 0] - W) / RES).astype(int); rows = ((N - pts[:, 1]) / RES).astype(int)
ok = (rows >= 0) & (rows < HEIGHT) & (cols >= 0) & (cols < WIDTH); rows, cols = rows[ok], cols[ok]
# channel elevation along the path: robust low envelope (rolling 10th percentile via min of smoothed)
ce = dem[rows, cols]
win = 25
ce_s = np.array([np.percentile(ce[max(0, i-win):i+win+1], 10) for i in range(len(ce))])
ce_s = np.minimum.accumulate(ce_s)  # water flows downhill: enforce non-increasing downstream
chan = np.zeros((HEIGHT, WIDTH), bool); chan[rows, cols] = True
celev = np.full((HEIGHT, WIDTH), np.nan, np.float32); celev[rows, cols] = ce_s
dist, (ir, ic) = distance_transform_edt(~chan, return_indices=True)
dist_km = dist * RES * 111.32 * np.cos(np.deg2rad(26.7))
hand = dem - celev[ir, ic]
np.save('hand.npy', hand.astype(np.float32)); np.save('dist_km.npy', dist_km.astype(np.float32))
H, DK = 5.0, 12.0
corr = (hand <= H) & (dist_km <= DK)
from scipy.ndimage import gaussian_filter, label, binary_fill_holes
corr = gaussian_filter(corr.astype(np.float32), 2.5) > 0.5
lab, n = label(corr); sz = np.bincount(lab.ravel()); keep = sz >= 1500; keep[0] = False; corr = keep[lab]
inv = ~corr; lab, n = label(inv); sz = np.bincount(lab.ravel()); small = sz < 1500; small[0] = False; corr |= small[lab]
np.save('corr.npy', corr)
px = (RES*111.32)**2*np.cos(np.deg2rad(26.7))
print('corridor km2', round(corr.sum()*px), 'channel elev start/end', round(ce_s[0]), round(ce_s[-1]))
