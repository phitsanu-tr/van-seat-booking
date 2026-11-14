const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:430,height:900}});
await p.goto('http://localhost:8765/trips.html');await p.waitForTimeout(2000);
await p.click('#tds button[data-k=night]');
console.log(JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('.pk')].map(x=>x.id+':'+x.getAttribute('data-lockmsg')+':'+x.textContent.trim().slice(0,30)))));
await b.close()})().catch(e=>console.log('ERR',e.message.slice(0,200)))
