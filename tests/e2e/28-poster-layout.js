// Share picture ("แชร์รูป" on the booking page): stays 9:16, and every gap is the same — left/right margin,
// above each section heading (measured from the ink of the words), and under the map card — for short and long trips.
const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
const near=(a,b)=>Math.abs(a-b)<=0.5;
(async()=>{const b=await chromium.launch(HLP.launchOpts);
const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(e.message));
await p.goto(B+'/api/auth?start=1&as=Ann&r=%2F');await p.waitForTimeout(400);
const trips={
  short:{name:'ห้วยแม่สะมาด น้ำตกห้วยน้ำใส เขื่อนผาบ่อง',meetPoint:'ลานจอดรถ BTS หมอชิต'},
  long:{name:'ทริปเดินป่าศึกษาธรรมชาติระยะไกล เขาช้างเผือก ทองผาภูมิ กาญจนบุรี ค้างคืน',meetPoint:'ลานจอดรถด้านหลังอาคารจอดแล้วจรสถานีรถไฟฟ้าหมอชิต ฝั่งสวนจตุจักร ประตู 2 ใกล้ร้านกาแฟ'}};
for(const [k,t] of Object.entries(trips)){
  const tr=await (await p.request.post(B+'/api/trip',{data:Object.assign({organizer:'ทัวร์',startDate:HLP.day(56),endDate:HLP.day(59),departTime:'20:00',returnTime:'14:00',tripN:3,tripStart:HLP.day(57),vans:[{label:'A',plate:'1กข 2025'}]},t)})).json();
  await p.goto(B+'/'+tr.id+'/seats');await p.waitForTimeout(1200);
  await p.click('#shareImg');
  await p.waitForFunction(()=>{const i=document.getElementById('imgPrev');return i&&i.naturalWidth>0&&window.__posterLayout},null,{timeout:30000});
  const r=await p.evaluate(()=>{const i=document.getElementById('imgPrev');const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const g=c.getContext('2d');g.drawImage(i,0,0);
    // the header wordmark: white "VAN" and yellow "TRIP" both drawn (top-left of the picture)
    const d=g.getImageData(0,0,Math.round(c.width/2),Math.round(c.width*0.09)).data;let yel=0,wht=0;for(let o=0;o<d.length;o+=4){if(d[o]>240&&d[o+1]>220&&d[o+1]<240&&d[o+2]<190&&d[o+2]>150)yel++;if(d[o]>245&&d[o+1]>245&&d[o+2]>245)wht++;}
    return {w:i.naturalWidth,h:i.naturalHeight,L:window.__posterLayout,yel,wht}});
  const L=r.L,X=L.side;
  const gaps=[L.h[0].inkTop-L.head, L.h[1].inkTop-L.c1[1], L.foot-L.c2[1]];
  const toCard=[L.c1[0]-L.h[0].inkBottom, L.c2[0]-L.h[1].inkBottom];
  log(k,'size',r.w+'x'+r.h,'9:16',Math.abs(r.h/r.w-16/9)<0.002,'| VAN + TRIP drawn',r.yel>500&&r.wht>500,
    '| gaps = side',gaps.every(g=>near(g,X)),
    '| heading→card equal',toCard.every(g=>near(g,L.hgap)));
  if(!gaps.every(g=>near(g,X))||!toCard.every(g=>near(g,L.hgap))) log('  detail side',X,'gaps',gaps.map(g=>g.toFixed(1)).join(','),'toCard',toCard.map(g=>g.toFixed(1)).join(','));
  await p.locator('#imgPrev').screenshot({path:S+'/28-poster-'+k+'.png'});
  await p.keyboard.press('Escape').catch(()=>{});
}
log('ERR',errs);await b.close();})().catch(e=>{console.log('ERR',e.message);process.exit(1)});
