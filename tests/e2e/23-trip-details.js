// Trip details page (#info): first visit, back/forward, the info/map/roster tabs and main button, owner/returning/seat-holder skip, "my trips" card tap
const HLP=require('../helpers');const {chromium}=require(HLP.PW);const B=HLP.BASE;const K={'x-owner-key':'test-owner-key-1234567'};
const log=(...a)=>console.log(...a);const errs=[];
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:900}});await HLP.fonts(c,{firstVisit:true});const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+encodeURIComponent(n)+'&r=%2F');return p}
const O=await user('Owner');
const t=await (await O.request.post(B+'/api/trip',{data:{tripN:2,tripStart:HLP.day(31),name:'ทริปรายละเอียด',organizer:'ทัวร์ตัวตึง',startDate:HLP.day(30),endDate:HLP.day(32),departTime:'19:00',returnTime:'14:00',meetPoint:'ลานจอดรถ BTS หมอชิต',vans:[{label:'1',plate:'1 กข 2025'}]}})).json();
await O.request.post(B+'/api/owner',{headers:K,data:{grant:{t:t.id,tester:true}}});
const ID=t.id;
const st=async p=>({hash:await p.evaluate(()=>location.hash),info:await p.evaluate(()=>document.body.classList.contains('v-info')),tab:await p.$eval('#viewSw [aria-selected=true]',e=>e.id),deck:await p.isVisible('#deck'),facts:await p.isVisible('#tripFacts')});
const P=await user('Pat');
await P.goto(B+'/'+ID);await P.waitForTimeout(1500);
log('first visit',JSON.stringify(await st(P)));
log('details text',(await P.innerText('#tripFacts')).replace(/\s+/g,' ').trim().includes('ผู้จัด ทัวร์ตัวตึง'),(await P.textContent('#tripFacts')).includes('19:00'),(await P.textContent('#tripFacts')).includes('14:00'),(await P.textContent('#tripFacts')).includes('ลานจอดรถ BTS หมอชิต'));
log('progress',(await P.innerText('#goSeats')).replace(/\s+/g,' ').trim());
await P.click('#goSeats');await P.waitForTimeout(400);log('after go seats',JSON.stringify(await st(P)));
await P.click('#swInfo');await P.waitForTimeout(300);log('info tab',JSON.stringify(await st(P)));
await P.goBack();await P.waitForTimeout(300);log('back',JSON.stringify(await st(P)));
await P.goBack();await P.waitForTimeout(300);log('back again',JSON.stringify(await st(P)));
await P.goto(B+'/'+ID);await P.waitForTimeout(1200);log('second visit',JSON.stringify(await st(P)));
await P.click('#swList');await P.waitForTimeout(400);log('roster button',JSON.stringify(await st(P)),'list shown',await P.isVisible('#listView'));
// book a seat from the map, then the details page shows it
await P.click('#swMap');await P.waitForTimeout(200);
const r=await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:3,name:'แพท'}});log('booked',r.status());
await P.evaluate(()=>history.replaceState(null,'',location.pathname+'#info'));await P.reload();await P.waitForTimeout(1800);log('details with my seat',(await P.innerText('#goSeats')).replace(/\s+/g,' ').trim());
// organizer, first visit: straight to the map
await O.goto(B+'/'+ID);await O.waitForTimeout(1500);log('organizer first visit',JSON.stringify(await st(O)));
// a new person whose link carries ?v=: straight to the map
const Q=await user('Qin');await Q.goto(B+'/'+ID+'?v=v1');await Q.waitForTimeout(1500);log('link with ?v',JSON.stringify(await st(Q)));
// a person who already holds a seat but never opened the trip on this device: straight to the map
const R=await user('Rin');await R.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:4,name:'ริน'}});await R.goto(B+'/'+ID);await R.waitForTimeout(1500);log('holds a seat',JSON.stringify(await st(R)));
// "my trips": tapping the card opens the details
const S=await user('Sun');await S.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:5,name:'ซัน'}});
await S.goto(B+'/mytrips?f='+Date.now()+'#seats');await S.waitForTimeout(2500);log('cards',await S.$$eval('.card',e=>e.map(x=>x.className)));
await S.evaluate(()=>{const c=document.querySelector('.card.tap');c.click()});await S.waitForTimeout(1800);log('after card tap',await S.evaluate(()=>location.pathname.replace(/[a-z0-9]{6,8}$/,'<id>')+location.hash),JSON.stringify(await st(S)));
log('ERR',errs);await b.close()})();
