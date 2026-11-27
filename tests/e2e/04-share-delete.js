const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(e.message));
await p.goto(B+'/api/auth?start=1&as=Ann&r=%2F');await p.waitForTimeout(400);
const tr=await (await p.request.post(B+'/api/trip',{data:{tripN:1,tripStart:HLP.day(45),meetPoint:'จุดนัดพบ',name:'ทดสอบรูป',organizer:'ทัวร์',startDate:HLP.day(45),departTime:'08:00',vans:[{label:'1'}]}})).json();const ID=tr.id;log('token in response?','token' in tr);
await p.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:3,name:'แอน'}});
await p.goto(B+'/'+ID+'/seats');await p.waitForTimeout(1200);log('mine tint',await p.locator('.seat.mine').count());
await p.click('#shareImg');await p.waitForTimeout(2500);log('poster',await p.evaluate(()=>{const i=document.querySelector('#imgBackdrop img');return i?i.naturalWidth+'x'+i.naturalHeight:'none'}));
const ext=await p.evaluate(()=>{const a=document.getElementById('imgExt')||document.querySelector('#imgBackdrop a[href*="img=1"]');return a?a.href:''});log('ext link',ext.replace(/mk=\w+/,'mk=…'));
// share sheet on the edit page: link, LINE and booking buttons; tapping the link box copies it
await p.goto(B+'/'+ID+'/edit');await p.waitForTimeout(1500);await p.click('#shareBtn');await p.waitForTimeout(500);
log('sheet',await p.textContent('#mState'),'| van',(await p.textContent('.vl .cd')).replace(/^VT\w{8}$/,'VT<k>'),'| tabs',await p.locator('#shTabs').isVisible(),'| copy-all btn hidden',await p.locator('#lineBtn').isHidden());await p.click('#tabO');await p.waitForTimeout(200);log('org',(await p.textContent('#orgCode')).replace(ID.toUpperCase(),'<ID>'),'| book',await p.getAttribute('#openShare','href')===('/'+ID+'/seats'));await p.click('#tabP');await p.waitForTimeout(200);
await p.click('.vl .cpbtn');await p.waitForTimeout(300);log('copied',await p.locator('.vl .cpbtn.ok').count());
// delete from edit page (dialog in-page)
await p.goto(B+'/'+ID+'/edit');await p.reload();await p.waitForTimeout(1500);await p.click('#delBtn');await p.waitForTimeout(400);
const btns=await p.$$eval('button',bs=>bs.filter(x=>x.offsetParent&&/ลบทริป/.test(x.textContent)).map(x=>x.id||x.className));log('confirm btns',btns);
await p.evaluate(()=>{const x=[...document.querySelectorAll('button')].filter(x=>x.offsetParent&&/ลบทริป/.test(x.textContent)&&x.id!=='delBtn');x[x.length-1].click()});await p.waitForTimeout(1500);
await p.waitForURL(/\/trips$/,{timeout:8000});await p.waitForTimeout(900);log('toast after delete',await p.evaluate(()=>{const t=document.getElementById('toast');return t&&!t.hidden?t.textContent.trim()+' | bottom '+(getComputedStyle(t).top==='auto'||innerHeight-t.getBoundingClientRect().bottom>0):'none'}));
log('after delete url',p.url(),'status',(await fetch(B+'/api/seats?t='+ID)).status);
log('ERR',errs);await b.close();})();
