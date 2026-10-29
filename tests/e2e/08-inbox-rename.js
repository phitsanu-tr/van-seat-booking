const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(300);return p;}
const A=await user('Ann'),P=await user('Pat'),Q=await user('Qin');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'เขาใหญ่ชิล ๆ',startDate:HLP.day(50),departTime:'07:00',meetPoint:'BTS หมอชิต',vans:[{label:'1'},{label:'2'}]}})).json();const ID=tr.id;
const put=t=>A.request.fetch(B+'/api/trip',{method:'PUT',data:{t:ID,name:'เขาใหญ่ชิล ๆ',startDate:HLP.day(50),departTime:t,meetPoint:'BTS หมอชิต',vans:[{id:'v1',label:'1'},{id:'v2',label:'2'}]}});
const inbox=async p=>{const d=await (await p.request.get(B+'/api/me?inbox=1')).json();return d.unread+'/'+d.items.length};
await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:3,name:'แพท'}});
await P.request.post(B+'/api/seats?t='+ID+'&v=v2',{data:{seat:5,name:'แพทสอง'}});
await Q.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:6,name:'ฉิน'}});
// 1) read state: mark read, a new notify arrives, old stays read, list not rewritten
await put('07:30');log('P before read',await inbox(P));
await P.request.post(B+'/api/me',{data:{read:'all'}});log('P after read all',await inbox(P));
await put('08:00');log('P after new notify',await inbox(P),'(expect 1 unread of 2)');
await P.request.post(B+'/api/me',{data:{read:{t:ID}}});log('P after read trip',await inbox(P));
// 3) bell updates on an open booking page without reload
await Q.goto(B+'/'+ID+'?v=v1');await Q.waitForTimeout(1500);
const badge=()=>Q.evaluate(()=>{const n=document.querySelector('.vb-n');return n&&!n.hidden?n.textContent:'-'});
log('Q badge start',await badge());await Q.click('.vb-bell').catch(()=>{});await Q.waitForTimeout(500);await Q.click('.vb-close').catch(()=>{});
await Q.request.post(B+'/api/me',{data:{read:'all'}});
await Q.reload();await Q.waitForTimeout(1500);log('Q badge after read+reload',await badge());await Q.mouse.move(100,300);
// a notification that does not change the trip facts: organizer renames Q's seat
await A.request.fetch(B+'/api/seats?t='+ID+'&v=v1',{method:'PATCH',data:{seat:6,name:'ฉินนี่'}});
let got='-',ms=0;for(;ms<20000;ms+=1000){await Q.mouse.move(100+ms%50,300);await Q.waitForTimeout(1000);got=await badge();if(got!=='-')break;}
log('Q badge after rename (no reload)',got,'within ~'+(ms+1000)/1000+'s');
// 5) rename menu: multi-seat (P) and single-seat (Q)
await P.goto(B+'/mytrips#seats');await P.waitForTimeout(1500);
log('ticket buttons',await P.$$eval('.tk .acts:last-child .ab, .acts.am2 .ab',e=>e.map(x=>x.textContent)));
await P.click('.ab.more');await P.waitForTimeout(300);await P.screenshot({path:S+'/r1.png'});
log('menu items',await P.$$eval('.pmenu button',e=>e.map(x=>x.textContent)));
await P.click('.pmenu button:first-child');await P.waitForTimeout(400);
log('picker',await P.$$eval('.spick button',e=>e.map(x=>x.textContent)),'input disabled',await P.isDisabled('.sheet .nin'));
await P.click('.spick button:nth-child(2)');await P.waitForTimeout(200);log('prefill',await P.inputValue('.sheet .nin'));
await P.fill('.sheet .nin','แพท2!@#abc');log('cleaned',await P.inputValue('.sheet .nin'),'count',await P.textContent('.nwrap .cnt'));
await P.fill('.sheet .nin','แพทใหม่');await P.screenshot({path:S+'/r2.png'});
await P.click('.sheet .b-danger');await P.waitForTimeout(1200);log('toast',await P.textContent('#toast'));
const seats=await (await P.request.get(B+'/api/seats?t='+ID+'&v=v2')).json();log('server v2 s5',JSON.stringify(seats.seats['5']&&seats.seats['5'].name||seats.seats));
log('menu closes on outside click');await P.click('.ab.more');await P.waitForTimeout(200);await P.keyboard.press('Escape');await P.waitForTimeout(200);log(' open after Esc',await P.$$eval('.pmenu',e=>e.length));await P.click('.ab.more');await P.waitForTimeout(200);await P.click('.ab.more');await P.waitForTimeout(200);log(' open after toggling',await P.$$eval('.pmenu',e=>e.length));
await P.click('.ab.more');await P.waitForTimeout(200);await P.click('.pmenu .dgr');await P.waitForTimeout(400);log('cancel sheet opens',await P.isVisible('.sheet'));await P.screenshot({path:S+'/r3.png'});
await Q.goto(B+'/mytrips#seats');await Q.waitForTimeout(1500);await Q.click('.ab.more');await Q.click('.pmenu button:first-child');await Q.waitForTimeout(400);
log('Q single: picker',await Q.$$eval('.spick',e=>e.length),'prefill',await Q.inputValue('.sheet .nin'));await Q.screenshot({path:S+'/r4.png'});
// 6) no dark css left
for(const u of ['/','/mytrips','/'+ID,'/trips','/privacy']){await Q.goto(B+u);await Q.waitForTimeout(500);log('dark rules',u,await Q.evaluate(()=>[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules]}catch(e){return []}}).filter(r=>/dark/.test(r.cssText)).length));}
log('ERR',errs);await b.close();})();
