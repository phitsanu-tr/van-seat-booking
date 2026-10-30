const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2,hasTouch:true,permissions:['clipboard-read','clipboard-write']});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(300);return p;}
const A=await user('Ann'),Bo=await user('Bob'),P=await user('Pat'),Q=await user('Qin'),R=await user('Rin');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'เขาใหญ่ชิล ๆ',startDate:HLP.day(10),departTime:'07:00',vans:[{label:'1'},{label:'2'}]}})).json();const ID=tr.id;
const inv=await (await A.request.post(B+'/api/trip',{data:{t:ID,invite:true}})).json();await Bo.request.post(B+'/api/trip',{data:{join:inv.invite.code}});
await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:3,name:'แพท'}});
await Q.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:5,name:'ฉิน'}});
await R.request.post(B+'/api/seats?t='+ID+'&v=v2',{data:{seat:2,name:'ริน'}});
const patch=(p,v,d)=>p.request.fetch(B+'/api/seats?t='+ID+'&v='+v,{method:'PATCH',data:d});
const roster=async()=>(await (await A.request.get(B+'/api/trip?t='+ID+'&roster=1')).json()).roster;
// --- API rules
log('paid tick is no longer accepted',(await patch(A,'v1',{seat:3,paid:true})).status());
log('passenger marks boarded',(await patch(Q,'v1',{seat:5,board:true})).status());
log('helper marks Rin boarded',(await patch(Bo,'v2',{seat:2,board:true})).status());
const pub=await (await Q.request.get(B+'/api/seats?t='+ID+'&v=v1')).json();
log('public seat fields',JSON.stringify(Object.values(pub.seats).map(s=>Object.keys(s).sort().join(','))));
let ro=await roster();log('roster flags',JSON.stringify({p3:ro.v1['3'].p||0,c2:!!ro.v2['2'].c}));
await patch(A,'v1',{seat:3,board:true});
await A.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{move:{fromVan:'v1',fromSeat:3,toVan:'v2',toSeat:7}}});
ro=await roster();log('boarded follows the move',!!(ro.v2['7']&&ro.v2['7'].c),'old seat gone',!ro.v1['3']);
await patch(A,'v2',{seat:7,board:false});
let lim=0;for(let i=0;i<12;i++){const r=await patch(A,'v1',{seat:5,board:i%2===0});if(r.status()===429)lim++;}log('12 quick ticks, rate limited',lim);
await patch(A,'v1',{seat:5,board:false});
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ros3');await A.waitForTimeout(800);
log('tabs',await A.$$eval('.rtabs button',e=>e.map(x=>x.textContent)));
// --- check-in tab, two organizers at once
await Bo.goto(B+'/mytrips');await Bo.waitForTimeout(1200);await Bo.click('.ros3');await Bo.waitForTimeout(800);await Bo.click('.rtabs button:nth-child(2)');await Bo.waitForTimeout(600);
await A.click('.rtabs button:nth-child(2)');await A.waitForTimeout(600);
const prog=p=>p.$eval('.bprog .pl span:last-child',e=>e.textContent);
log('board start A',await prog(A),'miss',await A.textContent('.miss'));
await A.click('.sheet .rrow.ck:has-text("ฉิน")');await A.waitForTimeout(700);
log('A after tick',await prog(A),'row in',await A.$$eval('.sheet .rrow.in',e=>e.length),'server',!!(await roster()).v1['5'].c);
await A.screenshot({path:S+'/board.png'});
let seen='',ms=0;for(;ms<15000;ms+=1000){await Bo.waitForTimeout(1000);seen=await prog(Bo);if(seen.startsWith('2'))break;}
log('Bob sees it without reloading',seen,'within ~'+(ms<9000?'8':'15')+'s');
await A.click('.sheet .rrow.ck:has-text("ฉิน")');await A.waitForTimeout(700);log('untick',await prog(A),'server',!!(await roster()).v1['5'].c);
await A.click('.rtools button:first-child');await A.waitForTimeout(400);log('copied missing',JSON.stringify(await A.evaluate(()=>navigator.clipboard.readText())));
// --- passenger cancels: the flags go with the seat
await R.request.fetch(B+'/api/seats?t='+ID+'&v=v2',{method:'DELETE',data:{seat:2}});ro=await roster();log('cancelled seat gone',!ro.v2['2']);
log('ERR',errs);await b.close();})();
