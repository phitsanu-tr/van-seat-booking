// LINE push: the text of each notice, and that a real LINE user id gets a multicast (to a local stand-in for the LINE API) only when a token is set.
const http=require('http');
process.env.UPSTASH_REDIS_REST_URL=process.env.UPSTASH_REDIS_REST_URL||'http://127.0.0.1:1';
const L=require('../../api/_lib');
const log=(...a)=>console.log(...a);
(async()=>{
const t='abcd2345';
for(const it of [{k:'queue_turn',t,tn:'ทริปเขาใหญ่'},{k:'trip_changed',t,tn:'ทริปเขาใหญ่'},{k:'trip_deleted',t,tn:'ทริปเขาใหญ่'},{k:'seat_moved',t,tn:'ทริปเขาใหญ่',fvl:'1',fs:3,tvl:'2',ts:5},{k:'seat_cancelled',t,tn:'ทริปเขาใหญ่',vl:'1',s:4},{k:'van_removed',t,tn:'ทริปเขาใหญ่',vl:'2'},{k:'seat_renamed',t,tn:'x'},{k:'plan_paid',tn:'x'}]){log(it.k,'=>',JSON.stringify(L.lineText(it)));}
const got=[];const srv=http.createServer((rq,rs)=>{let b='';rq.on('data',c=>b+=c);rq.on('end',()=>{got.push({auth:rq.headers.authorization,body:JSON.parse(b)});rs.end('{}')})});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));process.env.LINE_PUSH_URL='http://127.0.0.1:'+srv.address().port+'/push';
const uid='U'+'0123456789abcdef'.repeat(2);
delete process.env.LINE_BOT_TOKEN;await L.linePush([uid],'hi');log('no token: nothing sent',got.length===0);
process.env.LINE_BOT_TOKEN='tok';await L.linePush(['dev-user-1',uid,uid],'hello');
log('token: one multicast',got.length===1,'to real id only',JSON.stringify(got[0].body.to.length),'auth',got[0].auth,'text',got[0].body.messages[0].text);
await L.linePush(['dev-user-1'],'x');log('no real id: nothing sent',got.length===1);
srv.close();log('ERR',[]);
})().catch(e=>{console.log('ERR',e.message);process.exit(1)});
