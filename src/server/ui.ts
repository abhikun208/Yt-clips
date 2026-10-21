export const UI_HTML = `<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>yt-clips</title><style>
:root{--bg:#0f1218;--card:#181d27;--fg:#e8ecf3;--mut:#8b95a7;--acc:#ffd60a;--ok:#3ddc97;--bad:#ff5c5c;--bd:#2a3140}
@media(prefers-color-scheme:light){:root{--bg:#f4f6fa;--card:#fff;--fg:#141922;--mut:#5b6577;--acc:#b58900;--ok:#0a8f5a;--bad:#c62828;--bd:#d9dfea}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--bd);flex-wrap:wrap}
h1{font-size:18px;margin:0}main{max-width:1100px;margin:0 auto;padding:16px}section{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 10px}button,select,input{font:inherit;color:inherit;background:transparent;border:1px solid var(--bd);border-radius:8px;padding:8px 12px}
button{cursor:pointer;background:var(--acc);color:#111;border-color:transparent;font-weight:600}button.sec{background:transparent;color:var(--fg);border-color:var(--bd)}button:disabled{opacity:.5}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}.stat{border:1px solid var(--bd);border-radius:10px;padding:10px}.stat b{display:block;font-size:22px}.mut{color:var(--mut);font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--bd)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.clip{display:grid;grid-template-columns:140px 1fr;gap:12px;border-top:1px solid var(--bd);padding:12px 0}.clip video,.clip img{width:140px;border-radius:8px;background:#000}
.presets{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(110px,1fr))}.pv{border:2px solid var(--bd);border-radius:10px;padding:4px;cursor:pointer;text-align:center;font-size:12px}.pv.sel{border-color:var(--acc)}.pv img{width:100%;border-radius:6px;display:block}
progress{width:100%}#login{max-width:420px;margin:15vh auto}@media(max-width:560px){.clip{grid-template-columns:1fr}.clip video{width:100%}}
</style></head><body>
<div id="login" hidden><section><h2>Login</h2><p class="mut">Server token daalo (YT_CLIPS_TOKEN).</p><div class="row"><input id="tok" type="password" placeholder="token" style="flex:1"><button id="go">Login</button></div><p id="lerr" class="bad"></p></section></div>
<div id="app" hidden><header><h1>🎬 yt-clips</h1><div class="row"><span id="gates" class="pill"></span><button id="run">Run now</button></div></header><main>
<section><h2>Status</h2><div class="grid" id="stats"></div></section>
<section><h2>Video add karo</h2><p class="mut">Sirf wahi video jiske rights aapke paas hain. Upload ke baad pipeline khud chalti hai (analyze → clips → edit → QC).</p>
<div class="row"><input id="file" type="file" accept="video/*,audio/*"><label class="row"><input id="auth" type="checkbox"> Mere paas rights/permission hai</label><button id="up">Upload</button></div><progress id="prog" value="0" max="100" hidden></progress><p id="umsg" class="mut"></p></section>
<section><h2>YouTube source (channel / playlist / video)</h2><p class="mut">Sirf aapka apna ya permission wala channel. Naye uploads aur purani videos dheere-dheere khud process hoti hain (yt-dlp server par installed hona chahiye).</p>
<div class="row"><input id="yurl" placeholder="https://www.youtube.com/@channel" style="flex:1;min-width:220px"><label class="row"><input id="yauth" type="checkbox"> Mere paas rights/permission hai</label><button id="yadd">Add</button></div><p id="ymsg" class="mut"></p><div id="ylist" class="mut"></div></section>
<section><h2>Caption style <span class="mut" id="curp"></span></h2><div class="row" style="margin-bottom:10px"><select id="base"></select><select id="pal"></select><select id="lang"><option value="en">Latin/Hinglish preview</option><option value="hi">Hindi preview</option></select><button id="save" class="sec">Is style ko default banao</button></div><div class="presets" id="presets"></div></section>
<section><h2>Clips</h2><div id="clips" class="mut">Abhi koi clip nahi.</div></section></main></div>
<script>
const $=s=>document.querySelector(s);let token=localStorage.getItem('ytc_token')||'',presets=[],cur=null,sel=null;
const H=()=>({'x-ytc':'1',...(token?{authorization:'Bearer '+token}:{})});
async function api(p,o={}){const r=await fetch(p,{...o,headers:{...H(),...(o.headers||{})},credentials:'same-origin'});if(r.status===401){show(false);throw new Error('401')}const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
function show(ok){$('#login').hidden=ok;$('#app').hidden=!ok}
$('#go').onclick=async()=>{token=$('#tok').value.trim();try{await api('/api/login',{method:'POST'});localStorage.setItem('ytc_token',token);show(true);init()}catch(e){$('#lerr').textContent='Token galat hai'}};
async function refresh(){const s=await api('/api/status');const c=(k,v)=>'<div class="stat"><span class="mut">'+k+'</span><b>'+v+'</b></div>';
const n=(a,k)=>(a.find(x=>x.state===k)||{n:0}).n;$('#stats').innerHTML=c('Videos',s.videos.reduce((a,x)=>a+x.n,0))+c('Jobs pending',s.jobs.filter(x=>['PENDING','RETRY','RUNNING'].includes(x.state)).reduce((a,x)=>a+x.n,0))+c('Jobs failed(DEAD)',n(s.jobs,'DEAD'))+c('Clips QC pass',n(s.clips,'QC_PASSED'))+c('Clips QC fail',n(s.clips,'QC_FAILED'))+c('Uploads',s.uploads.reduce((a,x)=>a+x.n,0));
const g=s.gates;$('#gates').innerHTML=(g.publishEnabled||g.commentsAutoPost||g.publicVisibilityAllowed)?'<span class="bad">publish gate ON</span>':'<span class="ok">publish OFF (safe)</span>';
$('#run').disabled=s.running;$('#run').textContent=s.running?'Chal raha hai…':'Run now';
const cl=await api('/api/clips');$('#clips').innerHTML=cl.clips.length?cl.clips.map(c=>'<div class="clip"><div>'+(c.thumb?'<img loading="lazy" src="'+c.thumb+'">':'')+'<video controls preload="none" src="'+c.video+'"></video></div><div><b>'+esc(c.title||c.outputId)+'</b><div class="row"><span class="pill '+(c.qcPass?'ok':'bad')+'">QC '+(c.qcPass?'pass':'FAIL')+'</span><span class="pill">'+c.duration.toFixed(0)+'s</span><span class="pill">'+esc(c.category||'')+'</span></div><div class="mut">'+esc((c.description||'').slice(0,160))+'</div><div class="mut">'+esc((c.tags||[]).join(', '))+'</div><div class="row"><a href="'+c.video+'" download>MP4</a>'+(c.srt?'<a href="'+c.srt+'" download>SRT</a>':'')+'<a href="/api/manifest/'+c.outputId+'" target="_blank">manifest</a></div></div></div>').join(''):'Abhi koi clip nahi.'}
async function srcs(){const r=await api('/api/sources');$('#ylist').innerHTML=(r.ytdlp?'':'<span class="bad">yt-dlp installed nahi hai: sources save honge par download nahi hoga.</span><br>')+r.sources.filter(x=>x.kind!=='local').slice(0,8).map(x=>'<div>'+esc(x.status)+' · '+esc(x.title||x.uri)+'</div>').join('')}
$('#yadd').onclick=async()=>{try{if(!$('#yauth').checked)return $('#ymsg').textContent='Rights confirm karna zaroori hai';const r=await api('/api/sources',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:$('#yurl').value,authorized:true})});$('#ymsg').textContent=r.duplicate?'Pehle se added hai':'Add ho gaya';srcs()}catch(e){$('#ymsg').textContent='Error: '+e.message}};
const esc=s=>String(s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
function drawPresets(){const b=$('#base').value,p=$('#pal').value,l=$('#lang').value;const list=presets.filter(x=>(!b||x.base===b)&&(!p||x.palette===p));$('#presets').innerHTML=list.map(x=>'<div class="pv '+(x.id===sel?'sel':'')+'" data-id="'+x.id+'"><img loading="lazy" src="/api/presets/'+x.id+'/preview.png?lang='+l+'"><div>'+esc(x.label)+'</div></div>').join('');
document.querySelectorAll('.pv').forEach(e=>e.onclick=()=>{sel=e.dataset.id;drawPresets()})}
async function init(){const r=await api('/api/presets');presets=r.presets;cur=r.current;sel=cur;$('#curp').textContent='(abhi: '+cur+')';
const bs=[...new Set(presets.map(x=>x.base))],ps=[...new Set(presets.map(x=>x.palette))];$('#base').innerHTML='<option value="">Sab styles</option>'+bs.map(x=>'<option>'+x+'</option>').join('');$('#pal').innerHTML='<option value="">Sab colors</option>'+ps.map(x=>'<option>'+x+'</option>').join('');
['#base','#pal','#lang'].forEach(s=>$(s).onchange=drawPresets);drawPresets();refresh();srcs();setInterval(()=>{if(!document.hidden)refresh().catch(()=>{})},5000)}
$('#save').onclick=async()=>{try{await api('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({captionPreset:sel})});cur=sel;$('#curp').textContent='(abhi: '+cur+')'}catch(e){alert(e.message)}};
$('#run').onclick=async()=>{await api('/api/run',{method:'POST'});refresh()};
$('#up').onclick=()=>{const f=$('#file').files[0];if(!f)return $('#umsg').textContent='Pehle file chuno';if(!$('#auth').checked)return $('#umsg').textContent='Rights confirm karna zaroori hai';
const x=new XMLHttpRequest();x.open('POST','/api/upload?authorized=1&name='+encodeURIComponent(f.name));const h=H();for(const k in h)x.setRequestHeader(k,h[k]);$('#prog').hidden=false;
x.upload.onprogress=e=>{$('#prog').value=e.loaded/e.total*100};x.onload=()=>{$('#prog').hidden=true;let j={};try{j=JSON.parse(x.responseText)}catch{}$('#umsg').textContent=x.status<300?(j.duplicate?'Ye video pehle se hai':'Upload ho gaya, processing shuru'):'Error: '+(j.error||x.status);refresh()};x.onerror=()=>$('#umsg').textContent='Network error';x.send(f)};
(async()=>{try{await api('/api/login',{method:'POST'});show(true);init()}catch{show(false)}})();
</script></body></html>`;
