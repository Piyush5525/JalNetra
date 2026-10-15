import numpy as np, json, math, unicodedata, io
from PIL import Image
from scipy.ndimage import distance_transform_edt, binary_dilation, label
from grid import *
OUT = '/root/jalnetra-flood/map/src/'
import os; os.makedirs(OUT + 'img', exist_ok=True)
kmpx = RES * 111.32 * math.cos(math.radians(26.7)); px2 = (RES*111.32)**2*math.cos(math.radians(26.7))
def rc(lng, lat): return int((N - lat) / RES), int((lng - W) / RES)
def inb(r, c): return 0 <= r < HEIGHT and 0 <= c < WIDTH
strip = lambda s: ''.join(ch for ch in unicodedata.normalize('NFKD', s) if not unicodedata.combining(ch))
# --- imagery
s2 = np.load('s2b.npy').astype(np.float32); s2meta = json.load(open('s2b_meta.json'))
# gentle contrast stretch for a natural look
lo, hi = np.percentile(s2[s2.sum(2) > 0], [1, 99.5])
s2 = np.clip((s2 - lo) / (hi - lo), 0, 1) ** 0.9 * 255
im = Image.fromarray(s2.astype(np.uint8)); im.save(OUT + 'img/s2.jpg', quality=78, optimize=True, progressive=True)
print('s2.jpg', os.path.getsize(OUT + 'img/s2.jpg') // 1024, 'KB')
corr = np.load('corr.npy'); hand = np.load('hand.npy'); dist_km = np.load('dist_km.npy')
edge = corr & ~np.roll(corr, 1, 0) | corr & ~np.roll(corr, 1, 1) | corr & ~np.roll(corr, -1, 0) | corr & ~np.roll(corr, -1, 1)
edge = binary_dilation(edge, iterations=1)
rgba = np.zeros((HEIGHT, WIDTH, 4), np.uint8)
rgba[corr] = (245, 158, 11, 46); rgba[edge & binary_dilation(corr, iterations=1)] = (251, 191, 36, 210)
Image.fromarray(rgba).save(OUT + 'img/corridor.png', optimize=True)
meta = json.load(open('s1_meta.json'))
occ = np.load('occ.npy'); lc = np.load('lc.npy')
normal = occ >= 50
n_rgba = np.zeros((HEIGHT, WIDTH, 4), np.uint8); n_rgba[normal] = (226, 232, 240, 150)
Image.fromarray(n_rgba).save(OUT + 'img/normal.png', optimize=True)
obs = []; obs_new = {}
for k in ['o1', 'o2', 'o3']:
    z = np.load(f'{k}.npz'); new, valid = z['new'], z['valid']
    # keep clusters of at least 4 pixels to drop radar speckle
    new = new & ~normal
    lab, n = label(new); sizes = np.bincount(lab.ravel()); keep = sizes >= 4; keep[0] = False; new = keep[lab]
    obs_new[k] = (new, valid)
    disp = binary_dilation(new, iterations=1); ring = binary_dilation(disp, iterations=1) & ~disp
    a = np.zeros((HEIGHT, WIDTH, 4), np.uint8); a[ring] = (3, 37, 61, 150); a[disp] = (56, 189, 248, 245)
    Image.fromarray(a).save(OUT + f'img/{k}.png', optimize=True)
    m = meta[k]; obs.append({'id': k, 'time': m['flood_time'][:19] + 'Z', 'base': m['base_time'][:19] + 'Z', 'km2': round(float(new.sum() * px2), 1), 'coverage': m['coverage'], 'cropKm2': round(float((new & (lc == 40)).sum() * px2), 1), 'builtKm2': round(float((new & (lc == 50)).sum() * px2), 1)})
# --- river + stations
R = json.load(open('river_main.json')); path = [[round(x, 4), round(y, 4)] for x, y in R['path']]; km = [round(k, 2) for k in R['km']]
G = json.load(open('/root/jalnetra-flood/data/glofas_gandak_2026.json'))
labels = {'Devghat': 'Devghat, Nepal', 'Valmikinagar': 'Valmikinagar barrage', 'Bagaha': 'Bagaha', 'Dumariaghat': 'Dumariaghat', 'Rewaghat': 'Rewaghat', 'Lalganj': 'Lalganj', 'Hajipur': 'Hajipur'}
def hav(a, b):
    r = math.pi/180; dl = (b[1]-a[1])*r; dn = (b[0]-a[0])*r
    h = math.sin(dl/2)**2 + math.cos(a[1]*r)*math.cos(b[1]*r)*math.sin(dn/2)**2
    return 12742*math.asin(math.sqrt(h))
stations = []
for s in G['stations']:
    i = min(range(len(path)), key=lambda j: hav(path[j], (s['lng'], s['lat'])))
    w = s['q'][10:20]; pk = max(w)
    stations.append({'name': s['name'], 'label': labels[s['name']], 'lng': path[i][0], 'lat': path[i][1], 'km': km[i], 'q': s['q'], 'peakQ': pk, 'peakDay': 10 + w.index(pk)})
stations.sort(key=lambda s: s['km'])
# --- villages
V = json.load(open('/root/jalnetra-flood/analysis/vil26.json'))
O = json.load(open('osm.json')); dist_ = {k: strip(v) for k, v in O['district'].items()}
corr_d = distance_transform_edt(~corr) * kmpx
obs_d = {}
for k, (new, valid) in obs_new.items():
    obs_d[k] = (distance_transform_edt(~new) * kmpx, valid)
vill = []
for v in V:
    r, c = rc(v['lng'], v['lat'])
    if not inb(r, c): continue
    i = min(range(len(path)), key=lambda j: hav(path[j], (v['lng'], v['lat'])))
    si = min(range(len(stations)), key=lambda j: abs(stations[j]['km'] - km[i]))
    o = {}
    for k, (dd, valid) in obs_d.items():
        o[k] = round(float(dd[r, c]), 2) if valid[r, c] else None
    vill.append({'id': v['id'], 'name': v['name'], 'district': dist_.get(str(v['id']), ''), 'lng': v['lng'], 'lat': v['lat'], 'inCorr': bool(corr[r, c]), 'corrDist': round(float(corr_d[r, c]), 2), 'h': round(float(hand[r, c]), 1), 'dRiver': round(float(dist_km[r, c]), 2), 'si': si, 'obs': o})
# --- roads: flag ways crossing water seen on 29 Sep
new2 = binary_dilation(obs_new['o2'][0], iterations=1)
roads = []
for w in O['roads']:
    g = w['g']; cut = False
    for x, y in g:
        r, c = rc(x, y)
        if inb(r, c) and new2[r, c]: cut = True; break
    roads.append({'path': g, 'cut': cut, 'name': w['tags'].get('name', ''), 'ref': w['tags'].get('ref', ''), 'hw': w['tags'].get('highway')})
# --- candidate safe buildings: outside corridor, no water seen, within 5 km of an at-risk village
risk_pts = [(v['lng'], v['lat']) for v in vill if v['inCorr']]
shel = []
for s in O['shelters']:
    x, y = s['g']; r, c = rc(x, y)
    if not inb(r, c) or corr[r, c] or new2[r, c] or corr_d[r, c] < 0.3: continue
    if any(abs(x - a) < 0.05 and abs(y - b) < 0.05 for a, b in risk_pts):
        shel.append({'name': s['name'], 'amenity': s['amenity'], 'lng': x, 'lat': y})
# --- network for map mode
net = [w['g'] for w in O['rivers']]
base = json.load(open('/root/jalnetra-flood/app/src/base_gandak26.json'))
for f in base['features']:
    if f['properties']['kind'] == 'river' and f['properties']['name'] != 'Gandak':
        g = f['geometry']; ls = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        net += ls
json.dump({'type': 'FeatureCollection', 'features': [f for f in base['features'] if f['properties']['kind'] == 'country']}, open(OUT + 'countries.json', 'w'), separators=(',', ':'))
# --- event place + corridor check
new_o2 = obs_new['o2'][0]
near = new_o2 & (dist_km <= 15)
inside = (near & corr).sum() / max(near.sum(), 1)
seg_counts = []
for j in range(len(stations)):
    lo_k = (stations[j-1]['km'] + stations[j]['km'])/2 if j else 0
    hi_k = (stations[j]['km'] + stations[j+1]['km'])/2 if j < len(stations)-1 else 1e9
    seg_counts.append((j, lo_k, hi_k))
# assign each observation a place: river reach with the most new water within 15 km
pk = np.array(km); P = np.array(path)
def place(new):
    rr, cc = np.where(new & (dist_km <= 15))
    if len(rr) == 0: return 'No new water along the Gandak'
    sub = np.random.default_rng(0).choice(len(rr), min(4000, len(rr)), replace=False)
    lng = W + cc[sub] * RES; lat = N - rr[sub] * RES
    idx = [int(np.argmin((P[:, 0]-a)**2 + (P[:, 1]-b)**2)) for a, b in zip(lng, lat)]
    kms = pk[idx]
    best = max(range(len(stations)), key=lambda j: ((kms >= seg_counts[j][1]) & (kms < seg_counts[j][2])).sum())
    return f"Gandak floodplain near {stations[best]['label']}"
for o in obs: o['place'] = place(obs_new[o['id']][0])
rain = json.load(open('/root/jalnetra-flood/data/rain_nepal_2026.json'))
s2m = s2meta['scenes']; d0 = min(m['date'] for m in s2m)[:10]; d1 = max(m['date'] for m in s2m)[:10]
from datetime import date
fm = lambda s: date.fromisoformat(s).strftime('%b %Y')
data = {
    'bounds': [W, S, E, N], 's2bounds': s2meta['bounds'], 'start': G['start'], 'days': len(stations[0]['q']), 'obs': obs,
    'river': {'path': path, 'km': km, 'stations': stations}, 'network': net,
    'rain': {'points': [{'lng': p['lng'], 'lat': p['lat'], 'p': p['p']} for p in rain['points']]},
    'roads': roads, 'shelters': shel, 'villages': vill,
    'corridor': {'rule': 'land within 12 km of the Gandak and less than 5 m above its channel (Copernicus DEM)', 'check': f'{round(inside*100)}% of the new water radar saw on 29 Sep within 15 km of the river fell inside it.'},
    'regionLabels': [{'text': 'NEPAL', 'lng': 84.0, 'lat': 27.85, 'region': True}, {'text': 'BIHAR', 'lng': 85.05, 'lat': 26.55, 'region': True}, {'text': 'UTTAR PRADESH', 'lng': 83.8, 'lat': 26.35, 'region': True}],
    's2range': f'{fm(d0)} to {fm(d1)}, cloud-free mosaic', 'osmFetched': '06 Oct 2026',
}
aff = sorted([v for v in vill if v['obs'].get('o2') is not None and v['obs']['o2'] <= 0.5 and v['district']], key=lambda v: (v['obs']['o2'], -v['lat']))
data['spotlight'] = aff[0]['id'] if aff else vill[0]['id']
data['normalKm2'] = round(float(normal.sum() * px2), 1)
s = json.dumps(data, separators=(',', ':'))
open(OUT + 'data.json', 'w').write(s)
print('data.json', len(s)//1024, 'KB', 'villages', len(vill), 'roads', len(roads), 'cut', sum(r['cut'] for r in roads), 'shelters', len(shel))
print([(o['id'], o['km2'], o['cropKm2'], o['builtKm2'], o['place']) for o in obs], 'inside', round(inside, 3), 'spot', data['spotlight'])
print('states', sum(v['inCorr'] for v in vill), 'in corridor')
