import re,html,json,sys,os
d=sys.argv[1]; out={}
def txt(f):
    t=open(f).read();t=re.sub(r'<script.*?</script>|<style.*?</style>','',t,flags=re.S)
    return re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>',' ',t)))
for f in sorted(os.listdir(d)):
    t=txt(os.path.join(d,f)); slug=f[:-5]
    m=re.search(r'Skills Conquest (.*?) Expedition (.*?) (?:Skill Upgrade Order|Exclusive Gear|Shard Cost|Gear for)',t)
    exp=m.group(2) if m else ''
    skills=[]
    for sm in re.finditer(r'([A-Z][\w\'’ -]{2,40}?)\. (.*?)Scaling by level \(([^)]*)\): ([\d., ]+)\.',exp):
        skills.append({'name':sm.group(1).strip(),'desc':sm.group(2).strip(),'unit':sm.group(3),'levels':[float(x) for x in re.findall(r'[\d.]+',sm.group(4))]})
    if not skills and exp: skills=[{'raw':exp[:600]}]
    bs=re.search(r'Base Stats (.*?) Confidence',t)
    stats={}
    if bs:
        for k,v in re.findall(r'([A-Za-z %]+): ([\d,.]+)',bs.group(1)): stats[k.strip()]=float(v.replace(',',''))
    eg=re.search(r'Expedition bonuses: (.*?)\. Unlocks: (.*?)\.',t)
    gear={}; unlocks=[]
    if eg:
        for k,v in re.findall(r'([a-z %]+?) ([\d.]+)',eg.group(1)): gear[k.strip()]=float(v)
        unlocks=[x.strip() for x in eg.group(2).split('+')] if '+' in eg.group(2) else [x.strip() for x in re.split(r',| and ',eg.group(2))]
    gs=re.search(r'Exclusive Gear: (.*?) (?:Gear for|Documented|Shard Cost)',t)
    out[slug]={'expedition':skills,'baseStats':stats,'exclusiveGear':{'expedition':gear,'unlocks':unlocks,'text':gs.group(1)[:900] if gs else ''}}
json.dump(out,open(sys.argv[2],'w'),indent=1)
for k,v in out.items():
    print('##',k,v['baseStats'],v['exclusiveGear']['expedition'])
    for s in v['expedition']: print('   ',s.get('name'),'|',s.get('unit'),s.get('levels'),'|',(s.get('desc') or s.get('raw',''))[:150])
