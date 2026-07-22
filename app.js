/**
 * Wellness 知识问答库 — 双栏应用
 */
const WORKER_URL = 'https://gzu-wellness-qa.gzu-wellness.workers.dev';
const STORAGE_KEY = 'gzu_wellness_qa_config';

// ===== Config =====
function loadConfig() { try { const r=localStorage.getItem(STORAGE_KEY);return r?JSON.parse(r):{}; }catch{return{};} }
function saveConfig(c) { localStorage.setItem(STORAGE_KEY,JSON.stringify(c)); }

// ===== DOM — 左侧知识库 =====
const questionInput=document.getElementById('questionInput'),askBtn=document.getElementById('askBtn'),
  micBtn=document.getElementById('micBtn'),chatArea=document.getElementById('chatArea'),
  emptyState=document.getElementById('emptyState'),loading=document.getElementById('loading');

// ===== DOM — 右侧客户追踪 =====
const mrnInput=document.getElementById('mrnInput'),mrnBtn=document.getElementById('mrnBtn'),
  mrnResults=document.getElementById('mrnResults'),mrnEmpty=document.getElementById('mrnEmpty');

// ===== DOM — 底部共享 =====
const btnSettings=document.getElementById('btnSettings'),btnAdd=document.getElementById('btnAdd'),
  apiBadge=document.getElementById('apiBadge'),
  settingsOverlay=document.getElementById('settingsOverlay'),addOverlay=document.getElementById('addOverlay'),
  apiProvider=document.getElementById('apiProvider'),apiKeyInput=document.getElementById('apiKey'),
  btnSave=document.getElementById('btnSave'),btnClear=document.getElementById('btnClearClear'),
  btnCloseSettings=document.getElementById('btnCloseSettings'),btnCloseAdd=document.getElementById('btnCloseAdd'),
  tabQa=document.getElementById('tab-qa'),tabText=document.getElementById('tab-text'),
  addQuestion=document.getElementById('addQuestion'),addAnswer=document.getElementById('addAnswer'),
  addTitle=document.getElementById('addTitle'),addContent=document.getElementById('addContent'),
  btnAddSave=document.getElementById('btnAddSave'),addStatus=document.getElementById('addStatus');

// ===== Init =====
updateBadge();

// ===== 设置 Overlay =====
function openSettings(){ syncForm(); settingsOverlay.classList.remove('hidden'); }
function closeSettings(){ settingsOverlay.classList.add('hidden'); }
function openAdd(){ addOverlay.classList.remove('hidden'); }
function closeAdd(){ addOverlay.classList.add('hidden'); addStatus.textContent='';addStatus.className='add-status'; }

btnSettings.addEventListener('click',openSettings);
btnAdd.addEventListener('click',openAdd);
btnCloseSettings.addEventListener('click',closeSettings);
btnCloseAdd.addEventListener('click',closeAdd);
settingsOverlay.addEventListener('click',e=>{if(e.target===settingsOverlay)closeSettings();});
addOverlay.addEventListener('click',e=>{if(e.target===addOverlay)closeAdd();});

function updateBadge(){ const {apiKey}=loadConfig();
  apiBadge.style.display=apiKey?'inline':'none'; }

function syncForm(){ const{apiKey,provider}=loadConfig();
  apiKeyInput.value=apiKey;apiProvider.value=provider;
  document.querySelectorAll('.plink').forEach(l=>l.style.display=l.dataset.provider===provider?'inline':'none'); }

apiProvider.addEventListener('change',()=>{ const p=apiProvider.value;
  document.querySelectorAll('.plink').forEach(l=>l.style.display=l.dataset.provider===p?'inline':'none'); });

btnSave.addEventListener('click',()=>{ saveConfig({apiKey:apiKeyInput.value.trim(),provider:apiProvider.value});
  closeSettings(); updateBadge(); });

btnClear.addEventListener('click',()=>{ if(confirm('清除API Key？')){localStorage.removeItem(STORAGE_KEY);apiKeyInput.value='';updateBadge();} });

// ===== Tab =====
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(x=>x.classList.add('hidden'));
  document.getElementById('tab-'+t.dataset.tab).classList.remove('hidden'); }));

// ===== 添加知识 =====
btnAddSave.addEventListener('click',async()=>{
  const at=document.querySelector('.tab.active').dataset.tab; let body;
  if(at==='qa'){ const q=addQuestion.value.trim(),a=addAnswer.value.trim();
    if(!q||!a){addStatus.className='add-status error';addStatus.textContent='请填写问答';return;}
    body={type:'qa',question:q,answer:a}; }
  else{ const c=addContent.value.trim();
    if(!c){addStatus.className='add-status error';addStatus.textContent='请填写内容';return;}
    body={type:'text',title:addTitle.value.trim()||'用户添加',content:c}; }
  btnAddSave.disabled=true;addStatus.className='add-status';addStatus.textContent='⏳';
  try{
    const resp=await fetch(`${WORKER_URL}/api/add-knowledge`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await resp.json();
    if(resp.ok&&data.ok){ addStatus.className='add-status success';addStatus.textContent='✅ '+data.message;
      if(at==='qa'){addQuestion.value='';addAnswer.value='';}else{addTitle.value='';addContent.value='';} }
    else throw new Error(data.error||'失败');
  }catch(e){addStatus.className='add-status error';addStatus.textContent='❌ '+e.message;}
  btnAddSave.disabled=false;
});

// ===== 左侧: 知识库问答 =====
askBtn.addEventListener('click',handleAsk);
questionInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();handleAsk();}});
questionInput.addEventListener('input',()=>{questionInput.style.height='auto';questionInput.style.height=Math.min(questionInput.scrollHeight,100)+'px';});
document.querySelectorAll('.example').forEach(el=>el.addEventListener('click',()=>{questionInput.value=el.dataset.question;handleAsk();}));

async function handleAsk(){
  const q=questionInput.value.trim(); if(!q) return;
  const{apiKey,provider}=loadConfig();
  if(!apiKey){ openSettings(); renderError(q,'请先配置API Key'); return; }
  questionInput.value='';questionInput.style.height='auto';askBtn.disabled=true;
  emptyState.classList.add('hidden');loading.classList.remove('hidden');
  try{
    const resp=await fetch(`${WORKER_URL}/api/ask`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q,apiKey,provider})});
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.error||'请求失败');
    renderAnswer(q,data);
  }catch(e){renderError(q,e.message);}
  finally{loading.classList.add('hidden');askBtn.disabled=false;questionInput.focus();}
}

function renderAnswer(q,data){
  const card=document.createElement('div');card.className='qa-card';
  const qb=document.createElement('div');qb.className='question-bubble';qb.textContent=q;
  const ac=document.createElement('div');ac.className='answer-card';
  const cnt=document.createElement('div');cnt.className='answer-content';cnt.innerHTML=marked.parse(data.answer||'无回答');
  ac.appendChild(cnt);
  if(data.sources?.length){ const sd=document.createElement('div');sd.className='sources';
    const st=document.createElement('div');st.className='sources-title';st.textContent=`📖 来源(${data.sources.length})`;
    sd.appendChild(st);
    data.sources.forEach(s=>{ const si=document.createElement('div');si.className='source-item';
      si.innerHTML=`<span>📄</span><span>${escapeHtml(s.title||'知识库')}</span><span style="color:var(--text-muted);font-size:11px">${Math.round(s.relevance*100)}%</span>`;sd.appendChild(si); });
    ac.appendChild(sd); }
  card.appendChild(qb);card.appendChild(ac);chatArea.prepend(card);card.scrollIntoView({behavior:'smooth',block:'start'});
}

function renderError(q,msg){
  const card=document.createElement('div');card.className='qa-card';
  const qb=document.createElement('div');qb.className='question-bubble';qb.textContent=q;
  const ec=document.createElement('div');ec.className='error-card';
  ec.innerHTML=`<strong>⚠️ ${escapeHtml(msg)}</strong><br><button class="retry-btn">🔄 重试</button>`;
  ec.querySelector('.retry-btn').addEventListener('click',()=>{card.remove();questionInput.value=q;handleAsk();});
  card.appendChild(qb);card.appendChild(ec);chatArea.prepend(card);card.scrollIntoView({behavior:'smooth',block:'start'});
}

function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ===== 右侧: 客户追踪 =====
mrnBtn.addEventListener('click',lookupMRN);
mrnInput.addEventListener('keydown',e=>{if(e.key==='Enter')lookupMRN();});

async function lookupMRN(){
  const mrn=mrnInput.value.trim(); if(!mrn) return;
  mrnBtn.disabled=true; mrnResults.innerHTML='<div class="loading"><div class="typing-indicator"><span></span><span></span><span></span></div><p>查找中...</p></div>';
  try{
    const resp=await fetch(`${WORKER_URL}/api/client-lookup?mrn=${encodeURIComponent(mrn)}`);
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.error||'查询失败');
    renderClientResults(data);
  }catch(e){mrnResults.innerHTML=`<div class="error-card">⚠️ ${escapeHtml(e.message)}</div>`;}
  finally{mrnBtn.disabled=false;}
}

function renderClientResults(data){
  if(!data.records?.length){ mrnResults.innerHTML=`<div class="empty-state"><div class="empty-icon">📭</div><p>未找到 MRN "${escapeHtml(data.mrn)}" 的记录</p></div>`;return; }
  let html=`<div style="font-size:13px;color:var(--text-muted);text-align:center;margin-bottom:10px">找到 ${data.count} 条</div>`;
  // Group by MRN
  const groups={};
  data.records.forEach(r=>{ const k=r.mrn; if(!groups[k])groups[k]=[]; groups[k].push(r); });
  Object.entries(groups).forEach(([mrn,recs])=>{
    recs.forEach(r=>{
      // Clean remark
      const remark=(r.remark||'').replace(/<前端备注>/g,'').replace(/<ORE>/g,'').replace(/<商城E码>/g,'').trim();
      const name = r.name || r.fullName || '';
      const title = r.gender ? `${escapeHtml(name)} · ${escapeHtml(r.gender)} ${escapeHtml(r.age||'')}` : escapeHtml(name);
      html+=`<div class="client-card">
        <div class="cmrn">🏥 MRN: ${escapeHtml(mrn)}${title?` <span style="color:var(--text-secondary);font-size:13px">(${title})</span>`:''}</div>
        <div class="cinfo">
          ${r.task?`<span class="lbl">任务:</span><span class="val">${escapeHtml(r.task)}</span>`:''}
          ${r.dept?`<span class="lbl">科室:</span><span class="val">${escapeHtml(r.dept)}</span>`:''}
          ${r.wellness?`<span class="lbl">项目:</span><span class="val">${escapeHtml(r.wellness)}</span>`:''}
          ${r.date?`<span class="lbl">日期:</span><span class="val">${escapeHtml(r.date)}</span>`:''}
          ${r.room?`<span class="lbl">房间:</span><span class="val">${escapeHtml(r.room)}</span>`:''}
          ${r.status?`<span class="lbl">状态:</span><span class="val">${escapeHtml(r.status)} ${escapeHtml(r.billStatus||'')}</span>`:''}
          ${r.source?`<span class="lbl">渠道:</span><span class="val">${escapeHtml(r.source)}</span>`:''}
          ${r.consumption?`<span class="lbl">消费:</span><span class="val">${escapeHtml(r.consumption)}</span>`:''}
          ${r.packages?`<span class="lbl">套餐:</span><span class="val">${escapeHtml(r.packages)}</span>`:''}
          ${r.specialNote?`<span class="lbl">特殊:</span><span class="val" style="color:#dc2626">${escapeHtml(r.specialNote)}</span>`:''}
        </div>
        ${remark?`<div class="cremark">📝 ${escapeHtml(remark)}</div>`:''}
      </div>`;
    });
  });
  mrnResults.innerHTML=html;
}

// ===== 语音输入 =====
let isRecording=false,mediaRecorder=null,audioChunks=[],micStream=null;
micBtn.addEventListener('click',async()=>{
  if(isRecording){mediaRecorder.stop();return;}
  try{
    micStream=await navigator.mediaDevices.getUserMedia({audio:true});
    mediaRecorder=new MediaRecorder(micStream,{mimeType:'audio/webm'});audioChunks=[];
    mediaRecorder.ondataavailable=e=>{if(e.data.size>0)audioChunks.push(e.data);};
    mediaRecorder.onstop=async()=>{
      isRecording=false;micBtn.classList.remove('recording');micBtn.textContent='⏳';micBtn.disabled=true;
      micStream.getTracks().forEach(t=>t.stop());micStream=null;
      if(!audioChunks.length){micBtn.textContent='🎤';micBtn.disabled=false;return;}
      const blob=new Blob(audioChunks,{type:'audio/webm'});
      const fd=new FormData();fd.append('audio',blob,'recording.webm');
      try{
        const resp=await fetch(`${WORKER_URL}/api/speech`,{method:'POST',body:fd});
        const data=await resp.json();
        if(!resp.ok) throw new Error(data.error||'识别失败');
        questionInput.value=data.text||'';
      }catch(e){alert('语音识别失败: '+e.message);}
      finally{micBtn.textContent='🎤';micBtn.disabled=false;}
    };
    mediaRecorder.start();micBtn.classList.add('recording');micBtn.textContent='🔴';isRecording=true;
  }catch(e){
    isRecording=false;
    if(e.name==='NotAllowedError') alert('请允许麦克风权限');
    else alert('麦克风失败: '+e.message);
  }
});