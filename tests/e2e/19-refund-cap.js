const HLP=require('../helpers');const {chromium}=require(HLP.PW);const B=HLP.BASE;const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);const c=await b.newContext();const p=await c.newPage();
await p.goto(B+'/api/auth?start=1&as=Cap&r=%2F');await p.waitForTimeout(400);
const mk=async(n)=>(await (await p.request.post(B+'/api/trip',{data:{tripN:1,tripStart:HLP.day(30),meetPoint:'x',name:'cap'+n,organizer:'ท',startDate:HLP.day(30),departTime:'08:00',vans:[{label:'1'}]}})).json()).id;
const r=[];for(let i=1;i<=5;i++){const d=await (await p.request.delete(B+'/api/trip?t='+await mk(i))).json();r.push((d.refunded?'refund':'no')+(d.capped?'+capped':''));}
log('delete 1..5 (max 3 refunds a month)',r.join(' '));
const H={'x-owner-key':'test-owner-key-1234567'};
const a=await (await p.request.get(B+'/api/owner?audit',{headers:H})).json();
log('audit shows capped delete',(a.rows||[]).some(x=>x.e==='trip_delete'&&x.capped===1));
// ledger backfill is safe to repeat
const f1=await (await p.request.post(B+'/api/owner?backfill=1',{headers:H})).json(),f2=await (await p.request.post(B+'/api/owner?backfill=1',{headers:H})).json();
log('backfill ok, repeat adds nothing',f1.ok,f2.added===0);
log('ERR',[]);await b.close();})();
