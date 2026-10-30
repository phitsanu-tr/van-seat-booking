const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2,permissions:['clipboard-read','clipboard-write']});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(300);return p;}
const A=await user('Ann'),P=await user('Pat'),Q=await user('Qin');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'เขาใหญ่ชิล ๆ',organizer:'ทัวร์ตัวตึง',startDate:HLP.day(20),endDate:HLP.day(21),departTime:'07:00',meetPoint:'BTS หมอชิต',maxPerPerson:2,vans:[{label:'1',plate:'กข 1234'},{label:'2'}]}})).json();const ID=tr.id;
await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:3,name:'แพท'}});await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:1,name:'แพทสอง'}});
await Q.request.post(B+'/api/seats?t='+ID+'&v=v2',{data:{seat:5,name:'ฉิน'}});
const clip=()=>A.evaluate(()=>navigator.clipboard.readText());
const mask=t=>t.replace(/📅 .*/,'📅 <dates> · ออก 07.00 น.').replace(/\/[a-z0-9]{8}$/m,'/<id>');
// --- copy roster
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ros');await A.waitForTimeout(800);
await A.click('.rtools button:first-child');await A.waitForTimeout(500);log('toast',await A.textContent('#toast'));
log('copied text:\n'+mask(await clip()));
await A.request.post(B+'/api/trip',{data:{t:ID,close:true}});await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ros');await A.waitForTimeout(800);
await A.click('.rtools button:first-child');await A.waitForTimeout(500);log('closed trip last lines',JSON.stringify(mask(await clip()).split('\n').slice(-2)));
await A.request.post(B+'/api/trip',{data:{t:ID,close:false}});
// --- the "จัดการทริป" sheet: copy the list, close / reopen bookings
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ab.mgo');await A.waitForTimeout(800);
log('manage sheet',await A.$$eval('.mgb',e=>e.map(x=>x.textContent)));await A.screenshot({path:S+'/manage.png'});
await A.click('.mx');await A.waitForTimeout(300);log('x closes',await A.$$eval('.mgrid',e=>e.length));await A.click('.ab.mgo');await A.waitForTimeout(800);
await A.click('.mgb:has-text("คัดลอกรายชื่อ")');await A.waitForTimeout(400);log('sheet copy',await A.textContent('#toast'),'same text',mask(await clip()).split('\n').length);
await A.click('.mgb.lk');await A.waitForTimeout(200);log('first tap',(await A.textContent('.mgb.lk')).trim());await A.click('.mgb.lk');await A.waitForTimeout(1200);
const closedNow=async()=>(await (await A.request.get(B+'/api/seats?t='+ID+'&v=v1')).json()).closed;
log('closed',await closedNow(),'card share',(await A.textContent('.acts .ab.tl')).trim());
await A.click('.ab.mgo');await A.waitForTimeout(500);await A.click('.mgb.op');await A.waitForTimeout(1200);log('reopened',await closedNow());
// --- duplicate an upcoming trip
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);
await A.click('.ab.mgo');await A.waitForTimeout(300);log('duplicate link',(await A.getAttribute('.mgb:has-text("สร้างทริปซ้ำ")','href')).replace(ID,'<id>'));
await A.click('.mgb:has-text("สร้างทริปซ้ำ")');await A.waitForTimeout(1800);
const form=()=>A.evaluate(()=>({name:document.getElementById('name').value,org:document.getElementById('organizer').value,start:document.getElementById('startDate').value,end:document.getElementById('endDate').value,time:document.getElementById('departTime').value,meet:document.getElementById('meetPoint').value,max:document.getElementById('maxPer').value,close:document.getElementById('closeDate').value,vans:[...document.querySelectorAll('#vans input')].map(i=>i.value).filter(Boolean)}));
log('form',JSON.stringify(await form()),'lead',await A.textContent('#lead'));
await A.screenshot({path:S+'/dup_form.png'});
await A.click('#submit');await A.waitForTimeout(800);log('submit without dates ->',await A.$$eval('.fe',e=>e.map(x=>x.textContent)));
await A.evaluate(([d1,d2])=>{const s=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));};s('startDate',d1);s('endDate',d2);},[HLP.day(40),HLP.day(41)]);
await A.click('#submit');await A.waitForTimeout(1800);
const me=await (await A.request.get(B+'/api/me')).json();const mine=me.trips.filter(t=>t.name==='เขาใหญ่ชิล ๆ');
log('trips with that name',mine.length,'new id differs',mine.some(t=>t.id!==ID));
const nt=mine.find(t=>t.id!==ID);const full=await (await A.request.get(B+'/api/trip?t='+nt.id+'&roster=1')).json();
log('new trip',JSON.stringify({vans:full.trip.vans.map(v=>v.label+(v.plate?'/'+v.plate:'')),max:full.trip.maxPerPerson,booked:full.booked,dates:full.trip.startDate===HLP.day(40)}));
const old=await (await A.request.get(B+'/api/trip?t='+ID+'&roster=1')).json();log('original untouched',old.trip.startDate===HLP.day(20),old.booked);
// --- someone else's trip can't be copied
await P.goto(B+'/trips/new?copy='+ID);await P.waitForTimeout(1800);log('stranger copy: name empty',await P.inputValue('#name')==='','toast',await P.evaluate(()=>(document.querySelector('.toast')||{}).textContent||''));
// --- finished trip card
const done=await (await A.request.post(B+'/api/trip',{data:{name:'ทริปที่แล้ว',startDate:HLP.day(-5),endDate:HLP.day(-4),departTime:'06:00',vans:[{label:'A'}]}})).json();
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);
log('finished card links',await A.$$eval('.card.dim .dfoot > *',e=>e.map(x=>x.textContent)));
await A.click('.card.dim .cpy');await A.waitForTimeout(1800);log('copy finished trip: name',await A.inputValue('#name'),'start empty',await A.inputValue('#startDate')==='');
log('ERR',errs);await b.close();})();
