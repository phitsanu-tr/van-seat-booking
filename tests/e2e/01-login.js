const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function ctx(){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);return c;}
async function pg(c,n){const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));return p;}
log('anon create:',(await fetch(B+'/api/trip',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'x',vans:[{label:'1'}]})})).status);
const cA=await ctx();const A=await pg(cA,'A');await A.goto(B+'/api/auth?start=1&as=Ann&r=%2F');await A.waitForTimeout(600);
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'ทริปทดสอบ',startDate:HLP.day(20),vans:[{label:'1'}]}})).json();const ID=tr.id;log('A create ok',!!ID);
const sc=await fetch(B+'/api/seats?t='+ID+'&v=v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({seat:2,name:'anon'})});log('anon book:',sc.status);
const cN=await ctx();const N=await pg(cN,'N');await N.goto(B+'/'+ID);await N.waitForTimeout(1000);log('chip',await N.textContent('#acct'));
await N.click('.seat >> nth=1');await N.waitForTimeout(300);log('anon panel: lg',await N.locator('.lgbtn').count(),'input',await N.locator('#nameInput').count(),'note',await N.textContent('.lgnote'));await N.screenshot({path:S+'/7_forced.png'});
// anon /trips/new -> redirected to login -> back logged in
const cT=await ctx();const T=await pg(cT,'T');await T.goto(B+'/trips/new');await T.waitForTimeout(2000);log('trips/new ->',T.url(),'submit',await T.textContent('#submit'));
await T.goto(B+'/');await T.waitForTimeout(800);log('index chip logged',await T.textContent('#acct'));
const cH=await ctx();const H=await pg(cH,'H');await H.goto(B+'/');await H.waitForTimeout(800);log('index chip anon',await H.textContent('#acct'));await H.screenshot({path:S+'/8_home.png'});
log('ERR',errs);await b.close();})();
