const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:664},userAgent:LINE,deviceScaleFactor:2,hasTouch:true,isMobile:true});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(300);return p;}
// a short phone screen (LINE's in-app browser bars take room) and a full van
const A=await user('Ann');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'รถเต็มคัน',startDate:HLP.day(30),vans:[{label:'1'}],maxPerPerson:4}})).json();const ID=tr.id;
const names=['เฟิร์น','บอล','เฟรม','ตาน','ปอ','จ๋า','ท็อป','มิว','แนน','โอ๊ต','ฝน','เก่ง'];
for(let i=0;i<names.length;i++){const u=await user('U'+Math.floor(i/4));await u.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:i+2,name:names[i]}});await u.context().close();}
await A.goto(B+'/mytrips');await A.waitForTimeout(1200);await A.tap('.ros');await A.waitForTimeout(900);
const box=async()=>A.evaluate(()=>{const l=document.querySelector('.sheet .rlist'),sh=document.querySelector('.sheet'),last=l.lastElementChild.getBoundingClientRect(),lr=l.getBoundingClientRect(),close=[...sh.querySelectorAll('button')].pop().getBoundingClientRect();
 return {rows:l.children.length,scrollable:l.scrollHeight>l.clientHeight,lastVisible:last.bottom<=lr.bottom+1&&last.top>=lr.top-1,closeOnScreen:close.bottom<=innerHeight,sheetFits:sh.getBoundingClientRect().top>=0};});
log('before',JSON.stringify(await box()));await A.screenshot({path:S+'/roster_top.png'});
// swipe up inside the list
const r=await A.evaluate(()=>{const g=document.querySelector('.sheet .rlist').getBoundingClientRect();return {x:g.left+80,y:g.top+g.height*0.8};});
const cdp=await A.context().newCDPSession(A);
// raw touch events (a finger dragging upwards), several swipes to reach the end
for(let k=0;k<4;k++){const x=Math.round(r.x);let y=Math.round(r.y);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 for(let i=0;i<12;i++){y-=20;await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});await A.waitForTimeout(16);}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await A.waitForTimeout(500);}
log('after swipe',JSON.stringify(await box()));await A.screenshot({path:S+'/roster_bottom.png'});
log('ERR',errs);await b.close();})();
