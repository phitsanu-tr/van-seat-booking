const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function ctx(){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);return c;}
async function pg(c,n){const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));return p;}
log('anon create:',(await fetch(B+'/api/trip',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'x',vans:[{label:'1'}]})})).status);
const cA=await ctx();const A=await pg(cA,'A');await A.goto(B+'/api/auth?start=1&as=Ann&r=%2F');await A.waitForTimeout(600);
const tr=await (await A.request.post(B+'/api/trip',{data:{tripN:1,tripStart:HLP.day(20),meetPoint:'จุดนัดพบ',name:'ทริปทดสอบ',startDate:HLP.day(20),vans:[{label:'1'}]}})).json();const ID=tr.id;log('A create ok',!!ID);
const VAN=(tr.trip&&tr.trip.vans[0].id)||'v1';const sc=await fetch(B+'/api/seats?t='+ID+'&v='+VAN,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({seat:2,name:'anon'})});log('anon book:',sc.status);
const cN=await ctx();const N=await pg(cN,'N');await N.goto(B+'/'+ID);await N.waitForTimeout(1000);log('chip hidden for anon (LINE-first)',await N.locator('#acct').isHidden());
await N.click('.seat >> nth=1');await N.waitForTimeout(300);log('anon panel: lg',await N.locator('.lgbtn').count(),'input',await N.locator('#nameInput').count(),'note',await N.locator('.lgnote').count());await N.screenshot({path:S+'/7_forced.png'});
// anon /trips/new -> redirected to login -> back logged in
const cT=await ctx();const T=await pg(cT,'T');await T.goto(B+'/trips/new');await T.waitForTimeout(2000);
log('trips/new (LINE) ->',T.url().replace(B,''),'retry screen',await T.locator('text=เข้าสู่ระบบไม่สำเร็จ').count(),await T.locator('text=ลองใหม่').count());
const cP=await (async()=>{const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});await HLP.fonts(c);return c})();const Pp=await pg(cP,'P');await Pp.goto(B+'/trips/new');await Pp.waitForTimeout(1500);
log('trips/new (browser) -> open-in-LINE screen',await Pp.locator('text=กรุณาเปิดใน LINE').count(),await Pp.locator('text=เปิดใน LINE').count());
await T.goto(B+'/api/auth?start=1&as=ผู้ทดสอบ&r=%2Ftrips%2Fnew');await T.waitForTimeout(2000);log('after sign-in ->',new URL(T.url()).pathname,'submit',await T.textContent('#submit'));
await T.goto(B+'/');await T.waitForTimeout(1500);log('index logged ->',new URL(T.url()).pathname,'title',await T.textContent('#ltl'));
const cH=await ctx();const H=await pg(cH,'H');await H.goto(B+'/');await H.waitForTimeout(800);log('index chip anon hidden',await H.locator('#acct').isHidden());await H.screenshot({path:S+'/8_home.png'});
log('ERR',errs);await b.close();})();
