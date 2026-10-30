const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function ctx(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));return p;}
async function user(n){const p=await ctx(n);await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(300);return p;}
const A=await user('Ann'),C=await user('Cat');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'ทริปทีม',startDate:HLP.day(45),vans:[{label:'1'}]}})).json();const ID=tr.id;
await C.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:4,name:'แคท'}});
// A creates invite in UI
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ab.mgo');await A.waitForTimeout(300);await A.click('.mgb:has-text("ผู้ช่วยจัดทริป")');await A.waitForTimeout(700);await A.screenshot({path:S+'/t1.png'});
await A.click('.sheet .b-amber');await A.waitForTimeout(700);const url=await A.textContent('.ilink code');log('invite url',url.replace(/join=\w+/,'join=…'));await A.screenshot({path:S+'/t2.png'});
// B (not signed in) opens invite link -> login view -> sign in -> joined
const Bp=await ctx('Bob');await Bp.goto(url);await Bp.waitForTimeout(800);log('B sees login',await Bp.isVisible('#loginView'),await Bp.textContent('#loginErr'));
const href=await Bp.getAttribute('#loginBtn','href');await Bp.goto(B+href.replace('start=1','start=1&as=Bob'));await Bp.waitForTimeout(1500);log('B toast',await Bp.textContent('#toast'),'url',Bp.url());
await Bp.screenshot({path:S+'/t3.png'});log('B role line',await Bp.textContent('.rolep').catch(()=>'none'));
// helper rights
log('B cancel Cat seat',(await Bp.request.fetch(B+'/api/seats?t='+ID+'&v=v1',{method:'DELETE',data:{seat:4}})).status());
log('B PUT trip',(await Bp.request.fetch(B+'/api/trip',{method:'PUT',data:{t:ID,name:'ทริปทีม (แก้โดยผู้ช่วย)',startDate:HLP.day(45),vans:[{id:'v1',label:'1'}]}})).status());
log('B DELETE trip',(await Bp.request.fetch(B+'/api/trip?t='+ID,{method:'DELETE'})).status());
log('B invite',(await Bp.request.post(B+'/api/trip',{data:{t:ID,invite:true}})).status());
await Bp.goto(B+'/trips/'+ID);await Bp.reload();await Bp.waitForTimeout(1500);log('B edit page delete zone hidden',await Bp.evaluate(()=>document.getElementById('dz').hidden),'name',await Bp.inputValue('#name'));
// fill helpers to max
const code=url.split('join=')[1];
{const p=await user('Dan');log('Dan reuse used link',(await p.request.post(B+'/api/trip',{data:{join:code}})).status());}
const fresh=async()=>(await (await A.request.post(B+'/api/trip',{data:{t:ID,invite:true}})).json()).invite.code;
for(const n of ['Dan','Eve']){const p=await user(n);log(n,'join fresh',(await p.request.post(B+'/api/trip',{data:{join:await fresh()}})).status());}
const G=await user('Gus');const gj=await G.request.post(B+'/api/trip',{data:{join:await fresh()}});log('Gus join',gj.status(),JSON.stringify(await gj.json()));
// transfer to helper 0 (Bob) via UI
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.click('.ab.mgo');await A.waitForTimeout(300);await A.click('.mgb:has-text("ผู้ช่วยจัดทริป")');await A.waitForTimeout(800);await A.screenshot({path:S+'/t4.png'});
await A.click('.rrow >> nth=1 >> text=โอนให้');await A.click('.rrow >> nth=1 >> text=ยืนยันโอน?');await A.waitForTimeout(1200);
const team=await (await A.request.get(B+'/api/trip?t='+ID)).json();log('after transfer A role',team.team.role,'owner',team.team.ownerName,'helpers',team.team.helpers.map(h=>h.name).join(','));
log('A delete now',(await A.request.fetch(B+'/api/trip?t='+ID,{method:'DELETE'})).status());
// hold
const P=await ctx('anon');await P.goto(B+'/'+ID);await P.waitForTimeout(1000);
const h=await P.evaluate(async(id)=>{const r=await fetch('/api/seats?t='+id+'&v=v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:id,v:'v1',hold:2})});return [r.status,await r.json()]},ID);log('hold',h[0],!!h[1].hold);
const Q=await user('Que');await Q.goto(B+'/'+ID);await Q.waitForTimeout(1200);log('Q sees held',await Q.locator('.seat.held').count());await Q.screenshot({path:S+'/t5.png'});
log('Q book held seat',(await Q.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:2,name:'คิว'}})).status());
await Q.click('.seat.held');await Q.waitForTimeout(300);await Q.screenshot({path:S+'/t6.png'});
// full UI hold flow: anon R taps seat 6 -> login button -> hold -> back -> book
const R=await ctx('Ron');await R.goto(B+'/'+ID);await R.waitForTimeout(1000);
await R.evaluate(()=>[...document.querySelectorAll('.seat')].find(b=>b.getAttribute('aria-label').startsWith('ที่นั่ง 6')).click());await R.waitForTimeout(300);
await R.route('**/api/auth?start=1*',async route=>{const u=new URL(route.request().url());u.searchParams.set('as','Ron');await route.continue({url:u.toString()})});
await R.click('.lgbtn');await R.waitForTimeout(1800);log('R back panel',await R.textContent('#mTitle').catch(()=>'none'),'hold stored',await R.evaluate(()=>sessionStorage.getItem('vsb_hold')?1:0));
await R.click('#panel .primary');await R.waitForTimeout(1000);log('R booked',await R.textContent('#toast'),'hold cleared',await R.evaluate(()=>sessionStorage.getItem('vsb_hold')?1:0));
// owner console
const O=await ctx('owner');await O.goto(B+'/owner#test-owner-key-1234567');await O.waitForTimeout(1500);log('stats',await O.textContent('#sAcc'),await O.textContent('#sOwners'),await O.textContent('#sHelpers'));
await O.click('text=ดูประวัติทริป >> nth=0');await O.waitForTimeout(800);await O.screenshot({path:S+'/t7.png',fullPage:true});
log('ERR',errs);await b.close();})();
