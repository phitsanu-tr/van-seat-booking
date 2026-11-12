// @jitter
// A trip saved from an out-of-date form is refused, two simultaneous bookings never beat the per-person limit,
// and a write that comes from another website is refused.
const HLP=require('../helpers');const {chromium}=require(HLP.PW);const B=HLP.BASE;
const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844}});const p=await c.newPage();await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2Fprivacy');await p.waitForTimeout(500);return p}
const A=await user('Ann'),P=await user('Pat');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'ทริปกันทับ',startDate:HLP.day(5),endDate:HLP.day(6),departTime:'07:00',meetPoint:'BTS',maxPerPerson:2,vans:[{label:'1'}]}})).json();const ID=tr.id;
// 1) stale edit
const base={t:ID,name:'ทริปกันทับ',startDate:HLP.day(5),endDate:HLP.day(6),departTime:'07:00',meetPoint:'BTS',maxPerPerson:2,vans:[{id:'v1',label:'1'}]};
const g=await (await A.request.get(B+'/api/trip?t='+ID)).json();const rev0=g.trip.rev||0;
const e1=await A.request.fetch(B+'/api/trip',{method:'PUT',data:Object.assign({},base,{name:'แก้รอบแรก',rev:rev0})});
const e2=await A.request.fetch(B+'/api/trip',{method:'PUT',data:Object.assign({},base,{name:'แก้จากฟอร์มเก่า',rev:rev0})});
const e3=await A.request.fetch(B+'/api/trip',{method:'PUT',data:Object.assign({},base,{name:'แก้ไม่ส่ง rev'})});
const nm=(await (await A.request.get(B+'/api/trip?t='+ID)).json()).trip.name;
log('stale edit: first',e1.status(),'old form',e2.status(),(await e2.json()).error,'no rev',e3.status(),'name now',nm);
// 2) per-person limit under a burst (limit 2, six requests at once)
const url=B+'/api/seats?t='+ID+'&v=v1';
const rs=await Promise.all([1,2,3,4,5,6].map(n=>P.request.post(url,{data:{seat:n,name:'แพท'}})));
const okN=rs.filter(r=>r.ok()).length;
const got=(await (await A.request.get(B+'/api/trip?t='+ID+'&roster=1')).json()).roster.v1;
log('limit burst: held by Pat',Object.keys(got).length,'<= 2',Object.keys(got).length<=2);
// 3) write from another website
const x=await P.request.post(url,{data:{seat:9,name:'แพท'},headers:{origin:'https://evil.example'}});
const y=await P.request.post(B+'/api/auth',{data:{logout:true},headers:{origin:'https://evil.example'}});
log('cross-site write',x.status(),y.status());
log('ERR',errs);await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
