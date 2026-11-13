// @jitter
// Two people acting at the same moment must never bring back a cancelled seat or lose a passenger,
// a trip form left open must not undo someone else's close, and pages carry the security headers.
const HLP=require('../helpers');const {chromium}=require(HLP.PW);const B=HLP.BASE;
const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2Fprivacy');await p.waitForTimeout(300);return p;}
const A=await user('Ann'),P=await user('Pat'),Q=await user('Qin');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'ทริปพร้อมกัน',startDate:HLP.day(5),endDate:HLP.day(6),departTime:'07:00',tripN:2,tripStart:'2099-01-01',meetPoint:'BTS',maxPerPerson:0,vans:[{label:'1'}]}})).json();const ID=tr.id;
const url=B+'/api/seats?t='+ID+'&v=v1';
const book=(p,s,n)=>p.request.post(url,{data:{seat:s,name:n}});
const cancel=(p,s)=>p.request.fetch(url,{method:'DELETE',data:{seat:s}});
const patch=(p,d)=>p.request.fetch(url,{method:'PATCH',data:d});
const seats=async()=>(await (await A.request.get(B+'/api/trip?t='+ID+'&roster=1')).json()).roster.v1;
// 1) rename by the organizer at the same moment the passenger cancels: the seat must stay cancelled
let back=0;for(let i=0;i<4;i++){await book(P,3,'แพท');await Promise.all([patch(A,{seat:3,name:'แพทใหม่'}),cancel(P,3)]);if((await seats())['3'])back++;await cancel(A,3);}
log('rename vs cancel: cancelled seat came back',back,'of 4');
// 2) check-in tick at the same moment the passenger cancels
back=0;for(let i=0;i<4;i++){await book(P,4,'แพท');await Promise.all([patch(A,{seat:4,board:true}),cancel(P,4)]);if((await seats())['4'])back++;await cancel(A,4);}
log('tick vs cancel: cancelled seat came back',back,'of 4');
// 3) the organizer moves a passenger into a seat someone else is booking at that moment: nobody is lost or doubled
let bad=0;for(let i=0;i<4;i++){
  await book(P,6,'แพท');
  const [mv,bk]=await Promise.all([A.request.post(url,{data:{move:{fromVan:'v1',fromSeat:6,toVan:'v1',toSeat:7}}}),book(Q,7,'ฉิน')]);
  const s=await seats();const names=Object.values(s).map(x=>x.name);
  const pat=names.filter(n=>n==='แพท').length,qin=names.filter(n=>n==='ฉิน').length;
  if(pat!==1||qin!==(bk.ok()?1:0)||(mv.ok()&&bk.ok()))bad++;
  for(const n of Object.keys(s))await cancel(A,Number(n));
}
log('move vs booking: lost or doubled',bad,'of 4');
// 4) swap is all-or-nothing
await book(P,1,'แพท');await book(Q,2,'ฉิน');
const sw=await A.request.post(url,{data:{move:{fromVan:'v1',fromSeat:1,toVan:'v1',toSeat:2,swap:true}}});let s=await seats();
log('swap',sw.status(),s['1']&&s['1'].name,s['2']&&s['2'].name);
// 5) a trip form left open must not reopen bookings that a helper closed meanwhile
await A.goto(B+'/trips/'+ID);await A.waitForTimeout(1500);
await A.request.post(B+'/api/trip',{data:{t:ID,close:true}});
await A.fill('#name','ทริปพร้อมกันแก้ชื่อ');await A.click('#submit');await A.waitForTimeout(1800);log('form errors',await A.$$eval('.fe',e=>e.map(x=>x.textContent)),'toast',await A.evaluate(()=>{const t=document.querySelector('#toast,.toast');return t?t.textContent:''}));
const pub=await (await Q.request.get(url)).json();log('after saving a stale form: closed',pub.closed,'name',pub.trip.name);
// 6) security headers on the pages
const h=(await A.request.get(B+'/'+ID)).headers();log('headers',h['x-frame-options'],h['x-content-type-options'],h['content-security-policy']);
log('ERR',errs);await b.close();})();
