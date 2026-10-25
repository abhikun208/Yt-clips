// Owner-run browser E2E (needs playwright installed globally). Drives the real UI against a real server; the LLM endpoint is a local stand-in. Run: node --disable-warning=ExperimentalWarning test/real/ui-e2e.mjs
import { createApp } from '../../src/server/app.ts';
import { tmpDir, makeFixture } from '../../test/helpers.ts';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module'; const { chromium } = createRequire('/')(process.env.PLAYWRIGHT_PATH||'playwright');
const TOKEN='test-token-0123456789';
// stand-in LLM endpoint (local, NOT a real provider): accepts only key "good"
const llm=createServer((req,res)=>{ let b=''; req.on('data',d=>b+=d); req.on('end',()=>{ if(req.headers.authorization!=='Bearer goodkey123'){res.writeHead(401,{'content-type':'application/json'});return res.end('{"error":{"message":"bad key"}}')} res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content:'ok'}}]})) }) });
await new Promise(r=>llm.listen(0,'127.0.0.1',r)); const lport=llm.address().port;
const small={clip:{minSec:5,maxSec:12,targetSec:8,maxClipsPerVideo:2,minScore:0.2},edit:{width:270,height:480,preset:'ultrafast'}};
const app=createApp({host:'127.0.0.1',port:0,token:TOKEN,dataDir:tmpDir(),autoRun:false,overrides:small});
const port=await app.start(); const base=`http://127.0.0.1:${port}`; const auth={authorization:`Bearer ${TOKEN}`};
const src=tmpDir()+'/in.mp4'; await makeFixture(src,24); const body=readFileSync(src);
await fetch(`${base}/api/upload?authorized=1&name=in.mp4`,{method:'POST',headers:auth,body});
for(let i=0;i<150;i++){const s=await (await fetch(`${base}/api/status`,{headers:auth})).json();const cl=await (await fetch(`${base}/api/clips`,{headers:auth})).json();if(!s.running&&cl.clips.length&&cl.clips.every(c=>c.title))break;await new Promise(r=>setTimeout(r,1000))}
const br=await chromium.launch(); const pg=await (await br.newContext({viewport:{width:400,height:850}})).newPage();
const errs=[]; pg.on('pageerror',e=>errs.push('pageerror '+e.message)); pg.on('console',m=>{if(m.type()==='error')errs.push('console '+m.text())});
const ok=(c,m)=>console.log((c?'PASS ':'FAIL ')+m); const wait=ms=>pg.waitForTimeout(ms);
await pg.goto(base+'/'); await pg.fill('#tok',TOKEN); await pg.click('#go'); await wait(2500);
await pg.screenshot({path:'/tmp/home.png',fullPage:true});
ok((await pg.textContent('#todo')).length>10,'home todo rendered: '+(await pg.textContent('#todo')).slice(0,120).replace(/\s+/g,' '));
// settings: bad key then good key
await pg.click('nav [data-tab=settings]'); await wait(800);
await pg.selectOption('#aislot','1'); await pg.fill('#aibase',`http://127.0.0.1:${lport}/v1`); await pg.fill('#aimodel','m'); await pg.fill('#aikey','badkey1234'); await pg.click('#aillm'); await wait(1500);
ok(/Failed|✕/.test(await pg.textContent('#toast'))||/Failed/.test(await pg.textContent('#aist')),'bad key shows failure: '+(await pg.textContent('#toast')).slice(0,100));
await pg.fill('#aibase',`http://127.0.0.1:${lport}/v1`); await pg.fill('#aimodel','m'); await pg.fill('#aikey','goodkey123'); await pg.click('#aillm'); await wait(1800);
ok(/Connected/.test(await pg.textContent('#aist')),'good key shows Connected in list');
await pg.screenshot({path:'/tmp/settings.png',fullPage:true});
// clips
await pg.click('nav [data-tab=clips]'); await wait(1200);
const n0=await pg.locator('#clips .clip').count(); ok(n0>0,'clips in review: '+n0);
await pg.screenshot({path:'/tmp/clips.png',fullPage:true});
await pg.locator('#clips .clip [data-a=reject]').first().click(); await wait(400); await pg.click('#rgo'); await wait(1200);
ok((await pg.locator('#clips .clip').count())===n0-1,'rejected clip left review list');
ok(/Undo/.test(await pg.textContent('#toast')),'undo offered'); await pg.click('#toast button'); await wait(1200);
ok((await pg.locator('#clips .clip').count())===n0,'undo restored clip');
await pg.locator('#clips .clip [data-a=reject]').first().click(); await wait(400); await pg.click('#rgo'); await wait(1000);
await pg.locator('#filters [data-f=rejected]').click(); await wait(800);
ok((await pg.locator('#clips .clip [data-a=reset]').count())===1,'Rejected tab has Restore + reason: '+(await pg.locator('#clips .clip .bad').first().textContent()));
await pg.screenshot({path:'/tmp/rejected.png',fullPage:true});
await pg.locator('#clips .clip [data-a=reset]').click(); await wait(800);
await pg.locator('#filters [data-f=needs]').click(); await wait(600);
await pg.locator('#clips .clip [data-a=approve]').first().click(); await wait(1000);
await pg.locator('#filters [data-f=approved]').click(); await wait(600);
ok((await pg.locator('#clips .clip [data-a=queue]').count())===1,'approved clip has Queue button');
await pg.locator('#clips .clip [data-a=queue]').click(); await wait(800); await pg.screenshot({path:'/tmp/queue.png'});
await pg.click('#qdo'); await wait(2500);
ok((await pg.evaluate(()=>document.querySelector('#t-publish').classList.contains('on'))),'went to publish tab');
await wait(1500); await pg.screenshot({path:'/tmp/publish.png',fullPage:true});
ok(await pg.locator('#ups [data-up]').count()>0,'upload card in queue; text: '+(await pg.locator('#ups [data-up]').first().textContent()).slice(0,150));
ok(/Publish gate/.test(await pg.textContent('#ready')),'readiness checklist rendered');
// schedule
await pg.click('nav [data-tab=schedule]'); await wait(1500);
await pg.fill('[data-ch=main] [data-f=perDayCap]','3'); await pg.locator('[data-ch=main] [data-h="7"]').evaluate(e=>e.click()); await pg.click('[data-sv=main]'); await wait(1500);
const saved=await (await fetch(`${base}/api/channels`,{headers:auth})).json(); const m=saved.channels.find(c=>c.slug==='main');
ok(m.schedule.perDayCap===3&&m.schedule.baselineHours.includes(7),'schedule saved server-side: cap='+m.schedule.perDayCap+' hours='+m.schedule.baselineHours);
ok((await pg.textContent('[data-plan=main]')).length>5,'slot preview: '+(await pg.textContent('[data-plan=main]')).slice(0,100));
await pg.screenshot({path:'/tmp/schedule.png',fullPage:true});
// second channel + stagger visible
await pg.fill('#chn','Decider Gaming'); await pg.click('#chadd'); await wait(1500); ok(await pg.locator('[data-ch]').count()===2,'second channel added');
for (const t of ['insights','studio']) { await pg.click(`nav [data-tab=${t}]`); await wait(800) }
console.log('JS errors:',errs.length?errs:'none');
await br.close(); await app.stop(); llm.close(); process.exit(0);
