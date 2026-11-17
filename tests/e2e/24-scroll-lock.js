const HLP=require('../helpers');const {chromium}=require(HLP.PW);const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
// While a popup is open the page behind it must not scroll: the body is pinned at the current offset and the offset comes back on close.
(async()=>{const b=await chromium.launch(HLP.launchOpts);
const c=await b.newContext({viewport:{width:390,height:520},userAgent:LINE,deviceScaleFactor:1,hasTouch:true});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(e.message));
await p.goto(B+'/api/auth?start=1&as=Lock'+Date.now()+'&r=%2Fprivacy');await p.waitForTimeout(300);
const tr=await (await p.request.post(B+'/api/trip',{data:{name:'ล็อกเลื่อน',startDate:HLP.day(20),endDate:HLP.day(21),departTime:'07:00',returnTime:'17:00',tripN:2,tripStart:HLP.day(20),meetPoint:'BTS หมอชิต',vans:[{label:'1'}]}})).json();
const st=()=>p.evaluate(()=>({pos:document.body.style.position,top:document.body.style.top,y:Math.round(window.pageYOffset)}));
// 1) booking page: seat popup
await p.goto(B+'/'+tr.id+'/seats?x='+Date.now());await p.waitForTimeout(1500);
await p.evaluate(()=>window.scrollTo(0,150));await p.waitForTimeout(200);const y0=(await st()).y;log('booking: scrolled',y0>0);
await p.click('button[aria-label^="ที่นั่ง 9"]');await p.waitForTimeout(500);
let s=await st();const topO=parseInt(s.top);log('booking popup open: body pinned',s.pos,'page was scrolled',topO<0);
await p.keyboard.press('Escape');await p.waitForTimeout(300);
if((await st()).pos==='fixed'){await p.evaluate(()=>{const x=document.querySelector('#backdrop .x,#backdrop [aria-label="ปิด"],.modal .x');if(x)x.click()});await p.waitForTimeout(300)}
s=await st();log('booking popup closed: body free',s.pos==='','offset back',Math.abs(s.y+topO)<=1);
// 2) app page: bottom sheet
await p.goto(B+'/profile?x='+Date.now());await p.waitForTimeout(1800);
await p.click('.acti.dg');await p.waitForTimeout(400);s=await st();log('app sheet open: body pinned',s.pos);
await p.evaluate(()=>{const bd=document.querySelector('.bd');if(bd)bd.remove()});await p.waitForTimeout(200);s=await st();log('app sheet removed: body free',s.pos==='');
// 3) edit-trip page: the share popup (the one that showed the page scrolling behind it)
await p.goto(B+'/'+tr.id+'/edit?x='+Date.now());await p.waitForTimeout(2000);
await p.evaluate(()=>window.scrollTo(0,120));await p.waitForTimeout(200);
await p.click('#shareBtn');await p.waitForTimeout(500);s=await st();log('trip share popup open: body pinned',s.pos);
await p.evaluate(()=>{document.getElementById('backdrop').hidden=true});await p.waitForTimeout(300);s=await st();log('trip share popup closed: body free',s.pos==='');
log('ERR',errs);await b.close()})().catch(e=>{console.log('ERR',e.message);process.exit(1)});
