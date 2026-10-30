const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2,permissions:['clipboard-read','clipboard-write']});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(300);return p;}
const A=await user('Ann'),Bo=await user('Bob'),P=await user('Pat'),Q=await user('Qin');
const base={name:'เขาใหญ่ชิล ๆ',startDate:HLP.day(10),endDate:HLP.day(11),departTime:'07:00',vans:[{label:'1'},{label:'2'}]};
const tr=await (await A.request.post(B+'/api/trip',{data:base})).json();const ID=tr.id;
const inv=await (await A.request.post(B+'/api/trip',{data:{t:ID,invite:true}})).json();await Bo.request.post(B+'/api/trip',{data:{join:inv.invite.code}});
await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:3,name:'แพท'}});await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:4,name:'แพทสอง'}});
await Q.request.post(B+'/api/seats?t='+ID+'&v=v2',{data:{seat:5,name:'ฉิน'}});
const full=async()=>await (await A.request.get(B+'/api/trip?t='+ID+'&roster=1')).json();
const head=p=>p.$eval('.round',e=>e.querySelector('.n').textContent+' | '+e.querySelector('b').textContent);
// --- round 1
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ros3');await A.waitForTimeout(800);await A.click('.rtabs button:nth-child(2)');await A.waitForTimeout(600);
log('start',await head(A),'history button',await A.$$eval('.sheet .hist',e=>e.length),'new round button',(await A.textContent('.sheet .rnew')).trim());
await A.click('.sheet .rrow.ck:has-text("แพทสอง")');await A.waitForTimeout(500);await A.click('.sheet .rrow.ck:has-text("แพท") >> nth=0');await A.waitForTimeout(700);
log('ticked',await A.$eval('.bprog .pl span:last-child',e=>e.textContent));
await A.click('.round .rpen');await A.waitForTimeout(400);log('name dialog',await A.textContent('.bd:last-of-type h3'));
await A.click('.bd:last-of-type .vchips button:has-text("ขาไป")');await A.click('.bd:last-of-type .b-danger');await A.waitForTimeout(1000);
log('named',await head(A),'toast',await A.textContent('#toast'));
// --- new round
await A.click('.sheet .rnew');await A.waitForTimeout(400);
log('new dialog',await A.textContent('.bd:last-of-type h3'),'|',await A.textContent('.bd:last-of-type p'),'| button',await A.textContent('.bd:last-of-type .b-danger'));
await A.screenshot({path:S+'/round_dialog.png'});
await A.click('.bd:last-of-type .vchips button:has-text("ขากลับ")');await A.click('.bd:last-of-type .b-danger');await A.waitForTimeout(1200);
log('round 2',await head(A),'toast',await A.textContent('#toast'),'ticked now',await A.$eval('.bprog .pl span:last-child',e=>e.textContent));
let d=await full();
log('server cur',JSON.stringify({i:d.board.cur.i,name:d.board.cur.name,by:d.board.cur.by}),'hist',JSON.stringify(d.board.hist.map(h=>({i:h.i,name:h.name,n:h.n,total:h.total,miss:h.miss,by:h.by,times:!!(h.start&&h.end)}))));
log('ticks cleared',Object.values(d.roster).flatMap(v=>Object.values(v)).filter(s=>s.c).length);
// --- privacy: passengers never get trip.board
const pub=await (await P.request.get(B+'/api/seats?t='+ID+'&v=v1')).json();log('passenger trip has board',('board' in pub.trip),'passenger roster',(await P.request.get(B+'/api/trip?t='+ID+'&roster=1')).status());
// --- helper sees the same round
await Bo.goto(B+'/mytrips');await Bo.waitForTimeout(1200);await Bo.click('.ros3');await Bo.waitForTimeout(800);await Bo.click('.rtabs button:nth-child(2)');await Bo.waitForTimeout(600);log('helper sees',await head(Bo));
// --- history view
await A.click('.sheet .hist');await A.waitForTimeout(500);
log('history cards',await A.$$eval('.sheet .rc',e=>e.map(c=>c.querySelector('.rn').textContent+' '+c.querySelector('.rnm').textContent+' ['+c.querySelector('.rst').textContent+'] '+c.querySelector('.rmeta').textContent.replace(/\d+\.\d+/g,'hh.mm'))));
await A.screenshot({path:S+'/round_history.png'});
await A.click('.rtools button:first-child');await A.waitForTimeout(400);log('copied summary',JSON.stringify((await A.evaluate(()=>navigator.clipboard.readText())).replace(/\d+\.\d+ น\./g,'hh.mm น.')));
await A.click('.sheet .rback');await A.waitForTimeout(300);log('back',await head(A));
// --- unnamed round 3, odd names
await A.click('.sheet .rnew');await A.waitForTimeout(300);await A.click('.bd:last-of-type .b-danger');await A.waitForTimeout(1200);log('round 3',await head(A),'history',(await A.textContent('.sheet .hist')).trim());
await A.request.post(B+'/api/trip',{data:{t:ID,boardName:'  <b>แวะ\npั๊ม</b> ยาวมากกกกกกกกกกกกกกกกกกกกก  '}});d=await full();log('cleaned name',JSON.stringify(d.board.cur.name),d.board.cur.name.length);
// --- after the trip: read-only summary, no new rounds
await A.request.fetch(B+'/api/trip',{method:'PUT',data:Object.assign({t:ID},base,{startDate:HLP.day(-3),endDate:HLP.day(-2),vans:[{id:'v1',label:'1'},{id:'v2',label:'2'}]})});
log('new round after the trip',(await A.request.post(B+'/api/trip',{data:{t:ID,resetBoard:true}})).status());
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.card.dim .tmb');await A.waitForTimeout(800);await A.click('.rtabs button:nth-child(2)');await A.waitForTimeout(500);
log('ended view',await A.textContent('.sheet .rhead'),'cards',await A.$$eval('.sheet .rc',e=>e.length),'tick rows',await A.$$eval('.sheet .rrow.ck',e=>e.length),'new round button',await A.$$eval('.sheet .rnew',e=>e.length));
await A.screenshot({path:S+'/round_ended.png'});
log('ERR',errs);await b.close();})();
