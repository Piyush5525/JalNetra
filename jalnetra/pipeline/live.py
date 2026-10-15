import json
from datetime import date, timedelta
P='/root/jalnetra-flood/map/src/data.json'
D=json.load(open(P)); L=json.load(open('live.json'))
fetched=L['fetched']; today=fetched[:10]
names=['Devghat','Valmikinagar','Bagaha','Dumariaghat','Rewaghat','Lalganj','Hajipur']
peak={s['name']:s['peakQ'] for s in D['river']['stations']}
label={s['name']:s['label'] for s in D['river']['stations']}
st=[]; reasons=[]; level='none'
for n,v in zip(names,L['flood']['value']):
    d=v['daily']; ti=d['time'].index(today)
    fut=d['river_discharge_max'][ti+1:]
    s={'name':n,'label':label[n],'time':d['time'],'q':d['river_discharge'],'qmax':d['river_discharge_max'],'qmin':d['river_discharge_min'],'today':ti,'fmax':max(fut),'eventPeak':peak[n]}
    st.append(s)
    if s['fmax']>=0.8*peak[n]: level='warning'
    elif s['fmax']>d['river_discharge'][ti]*1.15 and level=='none': level='watch'
rd=L['rain']['value']; rt=rd[0]['daily']['time']; ri=rt.index(today)
rain=[{'lng':r['longitude'],'lat':r['latitude'],'next7':round(sum(r['daily']['precipitation_sum'][ri:ri+7]),1),'max1':max(r['daily']['precipitation_sum'][ri:ri+7])} for r in rd]
mx=max(r['next7'] for r in rain)
h=st[-1]; dv=st[0]
reasons.append(f"River falling at all {len(st)} points: {label['Hajipur']} {round(h['q'][h['today']]):,} m³/s today, down from {round(peak['Hajipur']):,} at the late-September peak")
reasons.append(f"Forecast keeps falling to {round(h['q'][-1]):,} m³/s by {date.fromisoformat(h['time'][-1]).strftime('%d %b')}")
reasons.append(f"Rain forecast for the Nepal catchment: at most {mx:g} mm over the next 7 days")
last={'o1':('2026-09-26',158),'o2':('2026-09-29',19),'o3':('2026-10-03',85)}
nxt=sorted({(date.fromisoformat(d0)+timedelta(days=12*k)).isoformat() for d0,_ in last.values() for k in range(1,4) if (date.fromisoformat(d0)+timedelta(days=12*k)).isoformat()>today})[:3]
D['live']={'fetched':fetched,'today':today,'stations':st,'rain':rain,'level':level,'reasons':reasons,'nextPasses':nxt}
json.dump(D,open(P,'w'),separators=(',',':'))
print(level, reasons, nxt)
