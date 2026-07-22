/**
 * GZU Wellness AI 知识库问答 + 客户追踪 — Cloudflare Worker
 * 知识库内嵌，不依赖GitHub
 */
import EMBEDDED_CHUNKS from './chunks-data.js';

const AI_PROVIDER = 'deepseek';
const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const GITHUB_OWNER = 'liuyx339-oss';
const GITHUB_REPO = 'gzu-wellness-qa';
const GITHUB_FILE = 'data/chunks.json';
const CLIENT_RECORDS_FILE = 'data/client_records.json';
const CLIENT_SOURCE2_FILE = 'data/client_records_source2.json';
const RAW_BASE = 'https://raw.githubusercontent.com';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
const TOP_K = 5;
const MAX_CONTEXT = 8000;

// 运行时知识库（启动时从内嵌数据初始化，永不过期）
let runtimeChunks = [...EMBEDDED_CHUNKS];

// 客户记录缓存（两个来源）
let clientCache = null, clientCacheTime = 0;
let clientCache2 = null, clientCacheTime2 = 0;
const CACHE_TTL = 60 * 1000;

// ============================================================
// 搜索
// ============================================================
const SYNONYM_MAP = {
  '打针':'能量针 静脉输注 IV营养疗法','喝酒':'酒精 肝脏 解毒 护肝','应酬':'肝脏 酒精 护肝 解毒',
  '美白':'谷胱甘肽 维C 提亮 肤色','累':'疲劳 乏力 精力差 能量','肝':'肝脏 护肝 解毒 肝功能',
  '失眠':'深眠 磁疗 rTMS 睡眠质量','老':'抗衰老 抗衰 衰老 年轻','免疫力差':'免疫力 免疫强化 抵抗力',
  '多少钱':'价格 费用 定价',
};
const KEYWORD_WEIGHTS = {
  'nad+':3,'nad':2,'能量针':2.5,'vitaglow':3,'proboost':3,'coreboost':3,'hydromax':3,
  'menergy':3,'微压氧':2.5,'深眠':2.5,'价格':1.5,'套餐':1.5,'免疫':2,'肝脏':2,'谷胱甘肽':2,
};

function expandQuery(query) {
  const l = query.toLowerCase(); let e = query;
  for (const [t,s] of Object.entries(SYNONYM_MAP)) { if (l.includes(t)) e += ' ' + s; }
  return e;
}

function extractKeywords(text) {
  const cleaned = text.replace(/[#*_~>\-|【】《》（）\s]+/g,' ').toLowerCase().trim();
  const tokens = new Set();
  cleaned.replace(/[a-z0-9+\-]+/gi, m => { tokens.add(m); return ''; });
  const c = cleaned.replace(/[^一-龥]+/g,'');
  for (let i=0;i<c.length-1;i++) tokens.add(c.substring(i,i+2));
  for (let i=0;i<c.length-2;i++) tokens.add(c.substring(i,i+3));
  return [...tokens];
}

function jaccardSimilarity(sa,sb) {
  let inter=0; for (const t of sa) if (sb.has(t)) inter++;
  return (sa.size+sb.size-inter)===0?0:inter/(sa.size+sb.size-inter);
}

function keywordScore(qt,cc,ct) {
  const comb = (ct+' '+cc).toLowerCase(); let s=0;
  for (const[k,w] of Object.entries(KEYWORD_WEIGHTS)) { if (comb.includes(k) && qt.includes(k)) s+=w; }
  const ws = qt.split(/\s+/).filter(w=>w.length>1);
  for (const w of ws) { if (comb.includes(w)) s+=0.5; }
  const ch = qt.replace(/[^一-龥]+/g,'');
  for (let len=4;len>=2;len--) for (let i=0;i<=ch.length-len;i++) { if(comb.includes(ch.substring(i,i+len))) s+=len*0.8; }
  return s;
}

function searchChunks(question, chunks, topK = TOP_K) {
  const expanded = expandQuery(question);
  const qt = new Set(extractKeywords(expanded)), el = expanded.toLowerCase();
  return chunks.map((chunk,i) => {
    const ck = new Set(extractKeywords(chunk.content)), tk = new Set(extractKeywords(chunk.title));
    return {i,chunk,score: jaccardSimilarity(qt,ck)*2 + jaccardSimilarity(qt,tk)*3 + keywordScore(el,chunk.content,chunk.title)*1.5};
  }).sort((a,b)=>b.score-a.score).filter(x=>x.score>0).slice(0,topK);
}

// ============================================================
// AI
// ============================================================
function buildSystemPrompt(contextChunks) {
  const ctx = contextChunks.map((item,i)=>`[文档${i+1}: ${item.chunk.title}]\n${item.chunk.content}`).join('\n\n---\n\n');
  return `你是 GZU Wellness 专业AI助手。严格基于以下知识库回答。\n\n${ctx}\n\n规则: 仅基于以上内容; 不知道就说不知道; 专业温暖有emoji; 价格/预约类提醒确认最新信息; 用中文`;
}

async function callDeepSeek(apiKey, systemPrompt, question) {
  const resp = await fetch(DEEPSEEK_API,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},body:JSON.stringify({model:DEEPSEEK_MODEL,messages:[{role:'system',content:systemPrompt},{role:'user',content:question}],temperature:0.5,max_tokens:2000})});
  if (!resp.ok) throw new Error(`DeepSeek: ${resp.status}`);
  return (await resp.json()).choices[0].message.content;
}

async function callOpenAI(apiKey,systemPrompt,question) {
  const resp = await fetch(OPENAI_API,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'system',content:systemPrompt},{role:'user',content:question}],temperature:0.5,max_tokens:2000})});
  if (!resp.ok) throw new Error(`OpenAI: ${resp.status}`);
  return (await resp.json()).choices[0].message.content;
}

async function callAnthropic(apiKey,systemPrompt,question) {
  const resp = await fetch(ANTHROPIC_API,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-5',max_tokens:2000,system:systemPrompt,messages:[{role:'user',content:question}]})});
  if (!resp.ok) throw new Error('Anthropic: '+resp.status);
  return (await resp.json()).content[0].text;
}

async function generateAnswer(apiKey, provider, systemPrompt, question) {
  if (provider==='deepseek') return callDeepSeek(apiKey,systemPrompt,question);
  if (provider==='anthropic') return callAnthropic(apiKey,systemPrompt,question);
  return callOpenAI(apiKey,systemPrompt,question);
}

// ============================================================
// 客户记录
// ============================================================
async function getClientRecords(env) {
  const now=Date.now();
  if(clientCache&&(now-clientCacheTime)<CACHE_TTL) return clientCache;
  const url = `${RAW_BASE}/${GITHUB_OWNER}/${GITHUB_REPO}/master/${CLIENT_RECORDS_FILE}`;
  const resp = await fetch(url);
  if(!resp.ok) throw new Error('加载客户记录失败: '+resp.status);
  clientCache = await resp.json();
  clientCacheTime = now;
  return clientCache;
}

async function getClientRecords2(env) {
  const now=Date.now();
  if(clientCache2&&(now-clientCacheTime2)<CACHE_TTL) return clientCache2;
  const url = `${RAW_BASE}/${GITHUB_OWNER}/${GITHUB_REPO}/master/${CLIENT_SOURCE2_FILE}`;
  const resp = await fetch(url);
  if(!resp.ok) throw new Error('加载客户记录2失败: '+resp.status);
  clientCache2 = await resp.json();
  clientCacheTime2 = now;
  return clientCache2;
}

// ============================================================
// GitHub 写入（UTF-8 安全）
// ============================================================
function stringToBase64(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function syncChunkToGitHub(env, chunk) {
  const token = env.GITHUB_PAT;
  if (!token) throw new Error('GitHub PAT 未配置');
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
  const getResp = await fetch(apiUrl,{headers:{Authorization:`Bearer ${token}`,'User-Agent':'gzu-qa'}});
  if (!getResp.ok) throw new Error(`GitHub GET: ${getResp.status}`);
  const fd = await getResp.json();
  const content = JSON.parse(atob(fd.content));
  const maxId = content.reduce((m,c)=>Math.max(m,c.id||0),0);
  chunk.id = maxId+1; content.push(chunk);
  const b64 = stringToBase64(JSON.stringify(content,null,2));
  const putResp = await fetch(apiUrl,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'User-Agent':'gzu-qa'},body:JSON.stringify({message:`Add: ${(chunk.title||'新内容').substring(0,50)}`,content:b64,sha:fd.sha})});
  if (!putResp.ok) { const e = await putResp.text(); throw new Error(`GitHub PUT: ${putResp.status} ${e}`); }
}

// ============================================================
// 入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method==='OPTIONS') return new Response(null,{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400'}});
    const url = new URL(request.url);

    // /api/ai-check
    if (url.pathname==='/api/ai-check') {
      try {
        return Response.json({ok:true,chunks:runtimeChunks.length,embedded:true},{headers:corsHeaders});
      } catch(e) { return Response.json({error:e.message},{status:500,headers:corsHeaders}); }
    }

    // /api/speech
    if (url.pathname==='/api/speech' && request.method==='POST') {
      try {
        const fd = await request.formData();
        const audio = fd.get('audio');
        if (!audio) return Response.json({error:'请提供音频'},{status:400,headers:corsHeaders});
        const bytes = new Uint8Array(await audio.arrayBuffer());
        let binary = '';
        for (let i=0;i<bytes.length;i+=4096) binary += String.fromCharCode.apply(null,bytes.subarray(i,i+4096));
        const result = await env.AI.run('@cf/openai/whisper',binary);
        return Response.json({text:result.text||''},{headers:corsHeaders});
      } catch(e) { return Response.json({error:e.message},{status:500,headers:corsHeaders}); }
    }

    // /api/client-lookup
    if (url.pathname==='/api/client-lookup') {
      try {
        const mrn = url.searchParams.get('mrn')?.trim() || '';
        if (!mrn) return Response.json({error:'请提供MRN'},{status:400,headers:corsHeaders});
        const [all1, all2] = await Promise.all([
          getClientRecords(env).catch(() => []),
          getClientRecords2(env).catch(() => []),
        ]);
        const matches = [
          ...all1.filter(r => r.mrn && r.mrn.includes(mrn)),
          ...all2.filter(r => r.mrn && r.mrn.includes(mrn)),
        ].slice(0, 30);
        return Response.json({count:matches.length, records:matches, mrn, sources:2},{headers:corsHeaders});
      } catch(e) { return Response.json({error:e.message},{status:500,headers:corsHeaders}); }
    }

    // /api/add-knowledge
    if (url.pathname==='/api/add-knowledge' && request.method==='POST') {
      try {
        const body = await request.json();
        const type = body.type||'qa'; let chunk={};
        if (type==='qa') {
          const q=body.question?.trim(),a=body.answer?.trim();
          if (!q||!a) return Response.json({error:'请提供question和answer'},{status:400,headers:corsHeaders});
          chunk={title:'user_用户添加',content:`## Q: ${q}\n\n${a}`,tokens_est:Math.floor((q.length+a.length)/2)};
        } else {
          const c=body.content?.trim();
          if (!c) return Response.json({error:'请提供content'},{status:400,headers:corsHeaders});
          chunk={title:body.title||'user_用户添加',content:c.substring(0,5000),tokens_est:Math.floor(c.length/2)};
        }
        // 1. 立即更新内存（立即可搜索）
        const maxId = runtimeChunks.reduce((m,c)=>Math.max(m,c.id||0),0);
        chunk.id = maxId+1;
        runtimeChunks.push(chunk);
        // 2. 异步写入GitHub（持久化）
        ctx.waitUntil(syncChunkToGitHub(env, chunk).catch(e => console.error('GitHub sync error:', e)));
        return Response.json({ok:true,message:'已添加，立即可搜索'},{headers:corsHeaders});
      } catch(e) { return Response.json({error:e.message},{status:500,headers:corsHeaders}); }
    }

    // /api/ask
    if (url.pathname!=='/api/ask' || request.method!=='POST') {
      return Response.json({error:'POST /api/ask | /api/client-lookup?mrn= | /api/add-knowledge | /api/speech'},{status:404,headers:corsHeaders});
    }
    try {
      const body = await request.json();
      const question = body.question?.trim();
      if (!question) return Response.json({error:'请提供question'},{status:400,headers:corsHeaders});
      const apiKey = body.apiKey||env.AI_API_KEY;
      const provider = body.provider||env.AI_PROVIDER||AI_PROVIDER;
      if (!apiKey) return Response.json({error:'请点击⚙️设置配置API Key'},{status:401,headers:corsHeaders});
      const relevant = searchChunks(question,runtimeChunks);
      let ctxChunks=[],totalLen=0;
      for (const item of relevant) { if (totalLen+item.chunk.content.length>MAX_CONTEXT) break; ctxChunks.push(item); totalLen+=item.chunk.content.length; }
      if (!ctxChunks.length) return Response.json({answer:'暂无相关信息，建议联系GZU Wellness获取最新信息',sources:[],question},{headers:corsHeaders});
      const answer = await generateAnswer(apiKey,provider,buildSystemPrompt(ctxChunks),question);
      return Response.json({answer,sources:ctxChunks.map(x=>({title:x.chunk.title,relevance:Math.round(x.score*100)/100})),question,chunks_used:ctxChunks.length},{headers:corsHeaders});
    } catch(err) {
      return Response.json({error:err.message},{status:500,headers:corsHeaders});
    }
  },
};