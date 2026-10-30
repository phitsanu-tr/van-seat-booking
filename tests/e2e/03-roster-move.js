const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(500);return p;}
const A=await user('Ann'),P=await user('Bob'),C=await user('Cat');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'ทริปจัดการ',startDate:HLP.day(45),vans:[{label:'1'},{label:'2'}]}})).json();const ID=tr.id;
await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:3,name:'บ็อบ'}});await C.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:4,name:'แคท'}});
const ros=async()=>JSON.stringify((await (await A.request.get(B+'/api/trip?t='+ID+'&roster=1',{headers:{'x-admin-key':'o'}})).json()).roster);
log('roster0',await ros());
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ros');await A.waitForTimeout(800);await A.screenshot({path:S+'/15_roster.png'});
// rename Bob
await A.click('.rrow >> nth=0 >> text=แก้ชื่อ');await A.waitForTimeout(200);await A.fill('.nin','บ็อบบี้');await A.click('.sheet .b-danger');await A.waitForTimeout(900);log('after rename',await ros());
// move Bob (row0) to van 2 seat 5
await A.click('.rrow >> nth=0 >> text=ย้าย');await A.waitForTimeout(200);await A.click('.sheet .vchips button >> nth=1');await A.waitForTimeout(200);await A.click('.sgrid button >> nth=4');await A.waitForTimeout(200);await A.screenshot({path:S+'/16_move.png'});await A.click('.sheet .b-danger');await A.waitForTimeout(900);log('after move',await ros());
// swap: in van1, Cat (seat4) with van2 seat5 (Bob)
await A.click('.sheet .vchips button >> nth=0');await A.waitForTimeout(200);await A.click('.rrow >> nth=0 >> text=ย้าย');await A.waitForTimeout(200);await A.click('.sheet .vchips button >> nth=1');await A.waitForTimeout(200);await A.click('.sgrid button >> nth=4');await A.waitForTimeout(200);log('swap btn',await A.textContent('.sheet .b-danger'));await A.click('.sheet .b-danger');await A.waitForTimeout(900);log('after swap',await ros());
// Bob's my seats reflect new place
log('bob me',JSON.stringify((await (await P.request.get(B+'/api/me')).json()).seats.map(x=>x.seats)));
// cancel Bob (now van1 seat4) via roster double tap
await A.click('.sheet .vchips button >> nth=0');await A.waitForTimeout(200);await A.click('.rrow >> nth=0 >> text=ยกเลิก');await A.click('.rrow >> nth=0 >> text=ยืนยัน?');await A.waitForTimeout(900);log('after cancel',await ros());
// passenger rename own seat in booking panel (Cat now van2 seat5)
await C.goto(B+'/'+ID+'?v=v2');await C.waitForTimeout(1200);await C.evaluate(()=>[...document.querySelectorAll('.seat')].find(b=>b.getAttribute('aria-label').includes('ที่นั่ง 5')).click());await C.waitForTimeout(300);
await C.screenshot({path:S+'/17_own.png'});await C.click('#panel button.plain:has-text("แก้ชื่อ")');await C.waitForTimeout(200);await C.fill('#nameInput','แคทลียา');await C.click('#panel .primary');await C.waitForTimeout(1000);log('after self rename',await ros(),await C.textContent('#toast'));
// Bob cannot rename Cat
log('bob rename cat',(await P.request.fetch(B+'/api/seats?t='+ID+'&v=v2',{method:'PATCH',data:{seat:5,name:'แฮก'}})).status());
// trips result sheet: no admin tab when signed in
await A.goto(B+'/trips/'+ID);await A.waitForTimeout(1500);await A.click('#shareBtn');await A.waitForTimeout(500);log('dots visible',await A.isVisible('#result .dots'));await A.screenshot({path:S+'/18_share.png'});
log('ERR',errs);await b.close();})();
