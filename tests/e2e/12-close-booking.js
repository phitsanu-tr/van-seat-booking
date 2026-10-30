const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
const bkk=m=>new Date(Date.now()+7*3600e3+m*60e3).toISOString().slice(0,16); // Bangkok "YYYY-MM-DDTHH:MM", m minutes from now
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2,hasTouch:true});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(300);return p;}
const A=await user('Ann'),P=await user('Pat'),Q=await user('Qin');
const base={name:'ทริปปิดจอง',startDate:HLP.day(20),endDate:HLP.day(21),departTime:'07:00',meetPoint:'BTS หมอชิต',vans:[{label:'1'}]};
const tr=await (await A.request.post(B+'/api/trip',{data:base})).json();const ID=tr.id;
const seats=(p,m,d)=>p.request.fetch(B+'/api/seats?t='+ID+'&v=v1',{method:m,data:d});
const st=async r=>r.status()+(r.status()>=400?' '+((await r.json().catch(()=>({}))).error||''):'');
const put=d=>A.request.fetch(B+'/api/trip',{method:'PUT',data:Object.assign({t:ID},base,{vans:[{id:'v1',label:'1'}]},d)});
const pub=async()=>(await (await P.request.get(B+'/api/seats?t='+ID+'&v=v1')).json()).closed;
await seats(P,'POST',{seat:3,name:'แพท'});await seats(Q,'POST',{seat:5,name:'ฉิน'});
// --- manual close: server rules
log('close',await st(await A.request.post(B+'/api/trip',{data:{t:ID,close:true}})),'seats GET closed',await pub());
log('passenger books',await st(await seats(P,'POST',{seat:4,name:'แพทสอง'})));
log('passenger holds',await st(await seats(P,'POST',{hold:6,hc:'abcdefgh12345678'})));
log('passenger cancels own',await st(await seats(P,'DELETE',{seat:3})));
log('passenger renames own',await st(await seats(P,'PATCH',{seat:3,name:'แพทตี้'})));
log('organizer books',await st(await seats(A,'POST',{seat:8,name:'แอน'})));
log('organizer moves',await st(await seats(A,'POST',{move:{fromVan:'v1',fromSeat:5,toVan:'v1',toSeat:7}})));
log('organizer cancels other',await st(await seats(A,'DELETE',{seat:8})));
// --- booking page: passenger vs organizer
await P.goto(B+'/'+ID);await P.waitForTimeout(1500);
log('P bar',await P.isVisible('#closedBar'),(await P.textContent('#closedBar')).trim().slice(0,14),'locked deck',await P.evaluate(()=>document.getElementById('deck').classList.contains('isended')));
await P.locator('.seat').nth(3).click();await P.waitForTimeout(400);log('P tap free seat opens panel',await P.isVisible('#backdrop'));
await P.screenshot({path:S+'/close_passenger.png'});
await A.goto(B+'/'+ID);await A.waitForTimeout(1500);
log('A bar hidden',await A.isHidden('#closedBar'),'A notice',(await A.textContent('#notice')).replace(/\s+/g,' ').trim());
await A.screenshot({path:S+'/close_organizer.png'});
// --- my trips: card pill, ticket note, cancel from the menu
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);log('card pill',await A.$$eval('.pill',e=>e.map(x=>x.textContent)),'share button',(await A.textContent('.acts .ab.tl')).trim());
await P.goto(B+'/mytrips#seats');await P.waitForTimeout(1200);log('ticket note',(await P.textContent('.cnote')).trim().slice(0,14));
await P.click('.ab.more');await P.click('.pmenu .dgr');await P.waitForTimeout(400);log('menu cancel ->',await P.textContent('#toast'),'sheet opened',await P.$$eval('.sheet',e=>e.length));
// --- reopen from the booking page (organizer)
await A.goto(B+'/'+ID);await A.waitForTimeout(1500);await A.click('#notice .go');await A.waitForTimeout(1200);log('A reopened',await A.textContent('#toast'),'closed now',await pub(),'notice',(await A.textContent('#notice')).replace(/\s+/g,' ').trim().slice(0,30));
// --- automatic closing time
log('closeAt in 1 day',await st(await put({closeAt:bkk(24*60)})),'closed',await pub(),'P books',await st(await seats(P,'POST',{seat:4,name:'แพทสอง'})));
await P.goto(B+'/'+ID);await P.waitForTimeout(1500);log('tip shows closing time',/ปิดรับจอง \d+ /.test(await P.textContent('#notice')));
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);log('card closing line',/^ปิดรับจองอัตโนมัติ \d+ /.test(await A.textContent('.cat')));
log('closeAt 1 min ago',await st(await put({closeAt:bkk(-1)})),'closed',await pub(),'P books',await st(await seats(P,'POST',{seat:9,name:'แพทสาม'})));
const r1=await (await A.request.post(B+'/api/trip',{data:{t:ID,close:false}})).json();
log('reopen after passed time: closed',r1.closed,'closeAt cleared',r1.trip.closeAt===''?'yes':JSON.stringify(r1.trip.closeAt),'P books',await st(await seats(P,'POST',{seat:9,name:'แพทสาม'})));
log('bad closeAt',await st(await put({closeAt:'tomorrow'})));
// --- roster sheet toggle (two taps) and the edit form switch
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ros3');await A.waitForTimeout(800);
await A.click('.rtools .lk');await A.waitForTimeout(200);log('first tap',(await A.textContent('.rtools .lk')).trim());await A.click('.rtools .lk');await A.waitForTimeout(800);
log('sheet closed',await A.textContent('#toast'),'note',await A.isVisible('.sheet .cnote'),'server',await pub());await A.screenshot({path:S+'/close_sheet.png'});
await A.goto(B+'/trips/'+ID);await A.waitForTimeout(1500);log('form switch shown',await A.isVisible('#closedRow'),'checked',await A.isChecked('#closedNow'));
await A.click('#closedNow');await A.click('#submit');await A.waitForTimeout(1500);log('saved with switch off: closed',await pub(),'form errors',await A.$$eval('.fe',e=>e.length));
await A.goto(B+'/trips/'+ID);await A.waitForTimeout(1500);await A.click('#closedNow');await A.click('#submit');await A.waitForTimeout(1500);log('saved with switch on: closed',await pub());
await A.goto(B+'/trips/'+ID);await A.waitForTimeout(1500);await A.evaluate(()=>{const s=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));};s('closeDate','2020-01-01');s('closeTime','10:00');});await A.click('#submit');await A.waitForTimeout(800);log('past closing time in form ->',await A.$$eval('.fe',e=>e.map(x=>x.textContent)));
await A.goto(B+'/trips/new');await A.waitForTimeout(1000);log('new form: switch hidden',await A.isHidden('#closedRow'));
log('ERR',errs);await b.close();})();
