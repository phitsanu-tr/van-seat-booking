const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function ctx(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));return p;}
const A=await ctx('Ann');await A.goto(B+'/api/auth?start=1&as=Ann&r=%2F');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'ทดสอบกัน',startDate:HLP.day(45),vans:[{label:'1'}]}})).json();const ID=tr.id;
// two anonymous phones, same network (same IP here)
const P1=await ctx('p1'),P2=await ctx('p2');
for(const [p,seat] of [[P1,2],[P2,5]]){await p.goto(B+'/'+ID);await p.waitForTimeout(800);await p.route('**/api/auth?start=1*',r=>r.abort());
  await p.evaluate(n=>[...document.querySelectorAll('.seat')].find(b=>b.getAttribute('aria-label').startsWith('ที่นั่ง '+n+' ')).click(),seat);await p.waitForTimeout(200);await p.click('.lgbtn');await p.waitForTimeout(800);}
const held=async()=>JSON.stringify((await (await fetch(B+'/api/seats?t='+ID+'&v=v1')).json()).held);
log('held after two phones on one network',await held());
// same phone holds another seat -> its old hold is released
await P1.goto(B+'/'+ID);await P1.waitForTimeout(800);await P1.evaluate(()=>[...document.querySelectorAll('.seat')].find(b=>b.getAttribute('aria-label').startsWith('ที่นั่ง 7 ')).click());await P1.waitForTimeout(200);await P1.click('.lgbtn');await P1.waitForTimeout(800);
log('held after phone 1 picks another seat',await held());
// polling backoff with a fake clock
const C=await ctx('poll');await C.clock.install();let n=0;C.on('request',r=>{if(r.url().includes('/api/seats?'))n++;});
await C.goto(B+'/'+ID);await C.waitForTimeout(800);n=0;
await C.clock.runFor(60000);log('active 1 min polls',n);n=0;
await C.clock.runFor(120000);n=0;await C.clock.runFor(240000);log('idle 3-7 min polls (expect ~8)',n);n=0;
await C.clock.runFor(600000);n=0;await C.clock.runFor(300000);log('idle >10 min, 5 min polls (expect ~5)',n);n=0;
await C.mouse.click(10,10);await C.waitForTimeout(300);log('poll on touch after idle',n);n=0;for(let i=0;i<8;i++){await C.clock.runFor(8000);await C.waitForTimeout(150);}log('active again ~1 min',n);
log('ERR',errs);await b.close();})();
