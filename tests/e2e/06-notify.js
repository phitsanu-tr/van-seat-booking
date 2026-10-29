const HLP=require('../helpers');const {chromium}=require(HLP.PW);const S=HLP.OUT;const B=HLP.BASE;
const LINE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0';const errs=[];const log=(...a)=>console.log(...a);
(async()=>{const b=await chromium.launch(HLP.launchOpts);
async function user(n){const c=await b.newContext({viewport:{width:390,height:844},userAgent:LINE,deviceScaleFactor:2});await HLP.fonts(c);const p=await c.newPage();p.on('pageerror',e=>errs.push(n+': '+e.message));await p.goto(B+'/api/auth?start=1&as='+n+'&r=%2F');await p.waitForTimeout(300);return p;}
const A=await user('Ann'),Bh=await user('Bob'),P=await user('Pat'),Q=await user('Qin');
const tr=await (await A.request.post(B+'/api/trip',{data:{name:'น้ำตกสายรุ้งละอองดาว',startDate:HLP.day(20),endDate:HLP.day(21),departTime:'21:00',meetPoint:'BTS หมอชิต',vans:[{label:'1'},{label:'2'}]}})).json();const ID=tr.id;
const inv=await (await A.request.post(B+'/api/trip',{data:{t:ID,invite:true}})).json();await Bh.request.post(B+'/api/trip',{data:{join:inv.invite.code}});
await P.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{seat:3,name:'แพท'}});await Q.request.post(B+'/api/seats?t='+ID+'&v=v2',{data:{seat:1,name:'ฉิน'}});
const put=await A.request.fetch(B+'/api/trip',{method:'PUT',data:{t:ID,name:'น้ำตกสายรุ้งละอองดาว',startDate:HLP.day(20),endDate:HLP.day(21),departTime:'20:30',meetPoint:'BTS หมอชิต',vans:[{id:'v1',label:'1'},{id:'v2',label:'2'}]}});log('put',put.status());
await Bh.request.post(B+'/api/seats?t='+ID+'&v=v1',{data:{move:{fromVan:'v1',fromSeat:3,toVan:'v2',toSeat:5}}});
await A.request.fetch(B+'/api/seats?t='+ID+'&v=v2',{method:'PATCH',data:{seat:1,name:'ฉินนี่'}});
const inbox=async p=>{const d=await (await p.request.get(B+'/api/me?inbox=1')).json();return d.unread+' '+d.items.map(x=>x.k).join(',')};
log('A',await inbox(A));log('B',await inbox(Bh));log('P',await inbox(P));log('Q',await inbox(Q));
// P: mytrips tags
await P.goto(B+'/mytrips#seats');await P.waitForTimeout(1500);log('P tags',await P.$$eval('.ntag',e=>e.map(x=>x.textContent)),'badge',await P.textContent('.vb-n'));await P.screenshot({path:S+'/n1.png'});
// P booking page
await P.goto(B+'/'+ID+'?v=v2');await P.waitForTimeout(1600);log('banner',(await P.textContent('#chgBan')).replace(/\s+/g,' '),'chg dd',await P.$$eval('.facts dd.chg',e=>e.map(x=>x.textContent)));await P.screenshot({path:S+'/n2.png'});
await P.click('.vb-bell');await P.waitForTimeout(600);await P.screenshot({path:S+'/n3.png'});await P.click('.vb-close');
await P.click('#chgBan .cx');await P.waitForTimeout(500);log('after x: banner hidden',await P.isHidden('#chgBan'),'badge hidden',await P.evaluate(()=>document.querySelector('.vb-n').hidden),'server',await inbox(P));
// A cancels Q, then deletes trip
await A.request.fetch(B+'/api/seats?t='+ID+'&v=v2',{method:'DELETE',data:{seat:1}});log('Q after cancel',await inbox(Q));
await A.request.fetch(B+'/api/trip?t='+ID,{method:'DELETE'});log('P after delete',await inbox(P),'B',await inbox(Bh));
await P.goto(B+'/');await P.waitForTimeout(1000);log('home badge',await P.textContent('.vb-n'));await P.click('.vb-bell');await P.waitForTimeout(500);await P.screenshot({path:S+'/n4.png'});
log('ERR',errs);await b.close();})();
