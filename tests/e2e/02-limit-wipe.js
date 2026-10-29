const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function ctx(){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);return c;}
async function pg(c,n){const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));return p;}
const cA=await ctx();const A=await pg(cA,'A');await A.goto(B+'/api/auth?start=1&as=Ann&r=%2Ftrips%2Fnew');await A.waitForTimeout(1200);
log('form select',await A.inputValue('#maxPer'));await A.fill('#name','ทริปจำกัดที่');await A.selectOption('#maxPer','2');await A.evaluate(([d1,d2])=>{const set=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};set('startDate',d1);set('endDate',d2);set('departTime','08:00');},[HLP.day(45),HLP.day(46)]);
await A.evaluate(()=>document.querySelector('#maxPer').scrollIntoView({block:'center'}));await A.waitForTimeout(200);await A.screenshot({path:S+'/9_form.png'});
await A.click('#submit');await A.waitForTimeout(1500);log('dbg',await A.evaluate(()=>({t:(document.querySelector('.toast')||{}).textContent,fe:[...document.querySelectorAll('.fe')].map(e=>e.textContent),url:location.href})));const h=await A.evaluate(()=>location.hash);log('created',h);const ID=h.slice(1).split('-')[0];
await A.reload();await A.waitForTimeout(1200);log('edit select',await A.inputValue('#maxPer'));
const cB=await ctx();const P=await pg(cB,'B');await P.goto(B+'/api/auth?start=1&as=Bob&r=%2F'+ID);await P.waitForTimeout(1200);
async function bookN(i){await P.click('.seat >> nth='+i);await P.waitForTimeout(300);await P.click('#panel .primary');await P.waitForTimeout(900);}
await P.click('.seat >> nth=1');await P.waitForTimeout(300);log('note',await P.locator('#panel .lgnote').textContent());await P.screenshot({path:S+'/10_note.png'});await P.click('#panel .primary');await P.waitForTimeout(900);
await bookN(2);await bookN(3);log('toast',await P.textContent('#toast'));await P.screenshot({path:S+'/11_limit.png'});
await P.goto(B+'/mytrips#seats');await P.waitForTimeout(1200);await P.click('#wipe');await P.waitForTimeout(300);await P.screenshot({path:S+'/12_wipe.png'});
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('#wipe');await A.waitForTimeout(300);await A.screenshot({path:S+'/13_wipe_owner.png'});
await A.click('.chk input');await A.click('.b-danger');await A.waitForTimeout(1200);log('after wipe login view',await A.isVisible('#loginView'),await A.textContent('#toast'));
const r=await fetch(B+'/api/seats?t='+ID);log('trip deleted status',r.status);
await A.goto(B+'/privacy');await A.waitForTimeout(800);await A.screenshot({path:S+'/14_privacy.png',fullPage:true});
log('ERR',errs);await b.close();})();
