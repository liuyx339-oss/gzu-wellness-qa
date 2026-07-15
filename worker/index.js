/**
 * GZU Wellness AI 知识库问答 — Cloudflare Worker
 *
 * 功能:
 * 1. 加载知识库 chunks（从 data/chunks.json）
 * 2. 接收用户问题 → 关键词匹配找最相关 chunks
 * 3. 调用 AI API 基于 chunks 生成回答
 * 4. 返回回答 + 来源引用
 *
 * 部署前配置:
 * - AI_API_KEY: 你的 AI API Key (OpenAI 或 Anthropic)
 * - AI_PROVIDER: "openai" 或 "anthropic"
 * - CHUNKS_URL: chunks.json 的 raw URL (GitHub raw content)
 */

// ============================================================
// 配置（通过 wrangler.toml 或 Cloudflare Dashboard 设置环境变量）
// ============================================================

// AI 提供商配置
const AI_PROVIDER = 'deepseek'; // 'deepseek' | 'openai' | 'anthropic'

// API 端点
const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// 公共 CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

// GitHub 配置（用于写入知识库）
const GITHUB_OWNER = 'liuyx339-oss';
const GITHUB_REPO = 'gzu-wellness-qa';
const GITHUB_FILE = 'data/chunks.json';
let cachedChunksSHA = null;  // 当前 chunks.json 的 GitHub SHA

// 知识库 chunks 的 GitHub raw URL
// 格式: https://raw.githubusercontent.com/{owner}/{repo}/main/data/chunks.json
const CHUNKS_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/data/chunks.json';

// 检索参数
const TOP_K = 5;        // 每次检索最相关的 K 个 chunks
const MAX_CONTEXT = 8000; // 最大上下文字符数

// ============================================================
// 文本相似度计算（基于关键词 Jaccard + TF 的简单检索）
// ============================================================

// ============================================================
// 同义词词典 —— 将口语化查询词扩展为专业术语
// ============================================================
const SYNONYM_MAP = {
  // 口语 → 专业术语
  "打针": "能量针 静脉输注 IV营养疗法",
  "打营养针": "能量针 IV营养疗法 静脉输注",
  "打点滴": "静脉输注 IV营养疗法 能量针",
  "输液": "静脉输注 IV营养疗法 能量针",
  "熬夜": "睡眠 疲劳 肝脏 作息",
  "喝酒": "酒精 肝脏 解毒 护肝",
  "应酬": "肝脏 酒精 护肝 解毒",
  "美白": "谷胱甘肽 维C 提亮 肤色",
  "疲劳": "疲劳 乏力 精力 能量 免疫力",
  "累": "疲劳 乏力 精力差 能量",
  "胖": "代谢 脂肪 体重 减重",
  "老": "抗衰老 抗衰 衰老 年轻",
  "免疫": "免疫力 免疫 抵抗力 胸腺法新",
  "免疫力差": "免疫力 免疫强化 抵抗力差 胸腺法新 免疫球蛋白",
  "肝": "肝脏 护肝 解毒 肝功能 谷胱甘肽 乙酰半胱氨酸",
  "肾": "肾脏 排毒 代谢",
  "睡眠": "睡眠 失眠 深眠 磁疗 rTMS",
  "失眠": "深眠 磁疗 rTMS 睡眠质量",
  "过敏": "过敏 免疫 免疫力 检测",
  "头痛": "头痛 偏头痛 神经系统 脑",
  "头晕": "头晕 眩晕 供血 脑循环",
  "关节": "关节 骨代谢 骨骼 疼痛",
  "体检": "检测 评估 套餐 健康评估",
  "基因": "基因检测 全外显子 外显子 测序",
  "维生素": "维生素检测 全套维生素 营养",
  "减肥": "代谢 减重 脂肪 左卡尼汀",
  "运动": "运动恢复 水合 电解质 能量 耐力",
  "男士": "男性 men energy 男",
  "女士": "女性 women female 女",
  "压力": "压力 紧张 焦虑 睡眠 脑",
  "记忆力": "记忆力 脑 认知 脑活素 神经",
  "皮肤": "皮肤 基因 检测 美容",
  "消炎": "抗炎 炎症 免疫 氧化",
  "癌症": "肿瘤 基因 检测 早筛 风险",
  "备孕": "备孕 生育 基因 遗传",
  "心脏": "心脏 体外反搏 心脏活力 心血管",
  "耳鸣": "耳鸣 微循环 供血 体外反搏",
  "多少钱": "价格 费用 定价 套餐价",
  "怎么": "如何 方式 方法 步骤",
  "什么": "哪些 哪款 推荐 介绍",
};

// 核心关键词列表（用于权重加分）
const KEYWORD_WEIGHTS = {
  "nad+": 3, "nad": 2, "能量针": 2.5, "vitaglow": 3, "proboost": 3,
  "coreboost": 3, "hydromax": 3, "menergy": 3, "coretein": 3,
  "neurogenex": 3, "微压氧": 2.5, "深眠": 2.5, "rtms": 2.5,
  "血浆置换": 2.5, "tpe": 2.5, "基因": 2, "维生素": 2,
  "价格": 1.5, "套餐": 1.5, "免疫": 2, "肝脏": 2, "谷胱甘肽": 2,
  "胸腺法新": 2, "白蛋白": 2, "脑活素": 2.5, "菲": 2,
  "女性": 2, "男性": 2, "检测": 1.5, "输注": 2,
};

/**
 * 扩展查询：将口语词替换为同义词
 */
function expandQuery(query) {
  const lower = query.toLowerCase();
  let expanded = query;

  for (const [term, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (lower.includes(term)) {
      expanded += ' ' + synonyms;
    }
  }

  return expanded;
}

/**
 * 提取关键词（2-4字中文词 + 英文单词）
 */
function extractKeywords(text) {
  const cleaned = text
    .replace(/[#*_~`>\-|【】《》（）\s]+/g, ' ')
    .toLowerCase()
    .trim();

  const tokens = new Set();

  // 英文词
  cleaned.replace(/[a-z0-9+\-]+/gi, m => { tokens.add(m); return ''; });

  // 中文：bigram + trigram
  const chinese = cleaned.replace(/[^一-龥]+/g, '');
  for (let i = 0; i < chinese.length - 1; i++) {
    tokens.add(chinese.substring(i, i + 2));
  }
  for (let i = 0; i < chinese.length - 2; i++) {
    tokens.add(chinese.substring(i, i + 3));
  }

  return [...tokens];
}

/**
 * 关键词匹配得分（权重加成）
 */
function keywordScore(queryText, chunkContent, chunkTitle) {
  const combined = (chunkTitle + ' ' + chunkContent).toLowerCase();
  let score = 0;

  // 核心关键词权重加成
  for (const [kw, weight] of Object.entries(KEYWORD_WEIGHTS)) {
    if (combined.includes(kw) && queryText.includes(kw)) {
      score += weight;
    }
  }

  // queryText 已经是扩展后的查询，直接用词匹配
  const queryWords = queryText.split(/\s+/).filter(w => w.length > 1);
  for (const word of queryWords) {
    if (combined.includes(word)) {
      score += 0.5;
    }
  }

  // 中文字串直接命中（在原始查询和chunk中都出现才加分）
  const chineseOnly = queryText.replace(/[^一-龥]+/g, '');
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i <= chineseOnly.length - len; i++) {
      const sub = chineseOnly.substring(i, i + len);
      if (combined.includes(sub)) {
        score += len * 0.8;
      }
    }
  }

  return score;
}

/**
 * Jaccard 相似度
 */
function jaccardSimilarity(setA, setB) {
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 检索最相关的 K 个 chunks（混合策略）
 */
function searchChunks(question, chunks, topK = TOP_K) {
  const expanded = expandQuery(question);
  const queryTokens = new Set(extractKeywords(expanded));
  // keywordScore 用扩展后的查询，确保同义词也能命中权重
  const expandedLow = expanded.toLowerCase();

  const scored = chunks.map((chunk, index) => {
    const chunkTokens = new Set(extractKeywords(chunk.content));
    const titleTokens = new Set(extractKeywords(chunk.title));

    // Jaccard 得分
    const contentJacc = jaccardSimilarity(queryTokens, chunkTokens);
    const titleJacc = jaccardSimilarity(queryTokens, titleTokens) * 3.0;

    // 关键词命中得分（用扩展后的查询）
    const kwScore = keywordScore(expandedLow, chunk.content, chunk.title);

    // 加权总分
    const score = contentJacc * 2 + titleJacc * 3 + kwScore * 1.5;

    return { index, chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(item => item.score > 0).slice(0, topK);
}

// ============================================================
// AI API 调用
// ============================================================

/**
 * 构建系统提示词
 */
function buildSystemPrompt(contextChunks) {
  const contextText = contextChunks
    .map((item, i) => `[文档${i + 1}: ${item.chunk.title}]\n${item.chunk.content}`)
    .join('\n\n---\n\n');

  return `你是 GZU Wellness Longevity Center 的专业AI助手。请严格基于以下知识库文档回答用户问题。

## 知识库内容:
${contextText}

## 回答规则:
1. **仅基于以上知识库内容回答**，不要编造信息
2. 如果知识库中没有相关信息，请诚实告知用户"目前知识库中暂无相关信息，建议直接联系GZU Wellness获取最新信息"
3. 回答要专业、温暖、有条理，适当使用emoji
4. 涉及价格、套餐、预约等敏感信息时，提醒用户"建议联系确认最新信息"
5. 用中文回答`;
}

/**
 * 调用 DeepSeek API（兼容 OpenAI 格式）
 */
async function callDeepSeek(apiKey, systemPrompt, question) {
  const response = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      temperature: 0.5,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API 错误: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * 调用 OpenAI API
 */
async function callOpenAI(apiKey, systemPrompt, question) {
  const response = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      temperature: 0.5,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API 错误: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * 调用 Anthropic API
 */
async function callAnthropic(apiKey, systemPrompt, question) {
  const response = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: question },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API 错误: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

/**
 * 调用 AI 生成回答
 */
async function generateAnswer(apiKey, provider, systemPrompt, question) {
  if (provider === 'deepseek') {
    return callDeepSeek(apiKey, systemPrompt, question);
  }
  if (provider === 'anthropic') {
    return callAnthropic(apiKey, systemPrompt, question);
  }
  return callOpenAI(apiKey, systemPrompt, question);
}

// ============================================================
// 缓存管理
// ============================================================

let chunksCache = null;
let chunksCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1分钟缓存（即时生效）

async function getChunks(env) {
  const now = Date.now();
  if (chunksCache && (now - chunksCacheTime) < CACHE_TTL) {
    return chunksCache;
  }

  const url = env.CHUNKS_URL || CHUNKS_URL;
  console.log(`Loading chunks from: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`加载知识库失败: ${response.status}`);
  }

  chunksCache = await response.json();
  chunksCacheTime = now;
  console.log(`Loaded ${chunksCache.length} chunks`);
  return chunksCache;
}

// ============================================================
// GitHub API — 写入知识库
// ============================================================

async function appendChunkToGitHub(env, chunk) {
  const token = env.GITHUB_PAT;
  if (!token) throw new Error('GitHub PAT 未配置');

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

  // Step 1: 读取当前文件
  console.log('Fetching current chunks.json from GitHub...');
  const getResp = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'gzu-wellness-qa' },
  });
  if (!getResp.ok) throw new Error(`GitHub GET 失败: ${getResp.status}`);

  const fileData = await getResp.json();
  const content = JSON.parse(atob(fileData.content));
  const sha = fileData.sha;

  // Step 2: 追加 chunk
  const maxId = content.reduce((m, c) => Math.max(m, c.id || 0), 0);
  chunk.id = maxId + 1;
  content.push(chunk);

  // Step 3: 写回
  const newContent = JSON.stringify(content, null, 2);
  console.log(`Writing chunks.json (${content.length} chunks, ${newContent.length} bytes)...`);

  const putResp = await fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'gzu-wellness-qa' },
    body: JSON.stringify({
      message: `📝 添加知识: ${(chunk.title || '新内容').substring(0, 50)}`,
      content: btoa(unescape(encodeURIComponent(newContent))),
      sha,
    }),
  });

  if (!putResp.ok) {
    const err = await putResp.text();
    throw new Error(`GitHub PUT 失败: ${putResp.status} ${err}`);
  }

  // 清除缓存，下次请求会重新从 raw URL 加载
  chunksCache = null;
  chunksCacheTime = 0;
  cachedChunksSHA = null;

  console.log('✅ 知识已添加');
  return chunk;
}

// ============================================================
// Worker 入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);

    // ===== 路由 /api/speech（Cloudflare AI Whisper）=====
    if (url.pathname === '/api/speech' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const audioFile = formData.get('audio');
        if (!audioFile) {
          return Response.json({ error: '请提供音频' }, { status: 400, headers: corsHeaders });
        }

        // Schema: input = 二进制 string（不是 {audio: ...} 包装）
        const bytes = new Uint8Array(await audioFile.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 4096) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
        }

        const result = await env.AI.run('@cf/openai/whisper', binary);
        return Response.json({ text: result.text || '' }, { headers: corsHeaders });

      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ===== 路由 /api/debug（调试：只看搜索不打AI）=====
    if (url.pathname === '/api/debug' && request.method === 'POST') {
      try {
        const body = await request.json();
        const q = body.question?.trim() || '';
        const chunks = await getChunks(env);
        const expanded = expandQuery(q);
        const results = searchChunks(q, chunks, 10);
        return Response.json({
          question: q,
          expandedQuery: expanded,
          totalChunks: chunks.length,
          found: results.length,
          top: results.slice(0, 5).map(r => ({
            title: r.chunk.title,
            content: r.chunk.content.substring(0, 200),
            score: Math.round(r.score * 100) / 100,
          })),
        }, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' } });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // ===== 路由 /api/add-knowledge =====
    if (url.pathname === '/api/add-knowledge' && request.method === 'POST') {
      try {
        const body = await request.json();
        const type = body.type || 'qa';
        let chunk = {};

        if (type === 'qa') {
          const q = body.question?.trim();
          const a = body.answer?.trim();
          if (!q || !a) {
            return Response.json({ error: '请提供 question 和 answer' }, {
              status: 400,
              headers: { 'Access-Control-Allow-Origin': '*' },
            });
          }
          chunk = {
            title: 'user_用户添加',
            content: `## Q: ${q}\n\n${a}`,
            tokens_est: Math.floor((q.length + a.length) / 2),
          };
        } else {
          const c = body.content?.trim();
          if (!c) {
            return Response.json({ error: '请提供 content' }, {
              status: 400,
              headers: { 'Access-Control-Allow-Origin': '*' },
            });
          }
          chunk = {
            title: body.title || 'user_用户添加',
            content: c.substring(0, 5000),
            tokens_est: Math.floor(c.length / 2),
          };
        }

        await appendChunkToGitHub(env, chunk);

        return Response.json({ ok: true, message: '知识已添加，约1分钟后可搜索到' }, {
          headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' },
        });

      } catch (err) {
        console.error('Add knowledge error:', err);
        return Response.json({ error: `添加失败: ${err.message}` }, {
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    // ===== 路由 /api/ask =====
    if (url.pathname !== '/api/ask' || request.method !== 'POST') {
      return Response.json({
        error: '请使用 POST /api/ask 或 POST /api/add-knowledge',
      }, {
        status: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      // 解析请求
      const body = await request.json();
      const question = body.question?.trim();

      if (!question) {
        return new Response(JSON.stringify({
          error: '请提供 question 字段',
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // 优先用请求中的 apiKey，否则用环境变量
      const apiKey = body.apiKey || env.AI_API_KEY;
      const provider = body.provider || env.AI_PROVIDER || AI_PROVIDER;

      if (!apiKey) {
        return new Response(JSON.stringify({
          error: '未配置 API Key。请点击右上角⚙️齿轮图标配置你的 API Key',
        }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // 加载知识库
      const chunks = await getChunks(env);

      // 检索相关 chunks
      const relevant = searchChunks(question, chunks);
      console.log(`Found ${relevant.length} relevant chunks for: "${question}"`);

      // 构建上下文（控制长度）
      let contextChunks = [];
      let totalLen = 0;
      for (const item of relevant) {
        const chunkLen = item.chunk.content.length;
        if (totalLen + chunkLen > MAX_CONTEXT) break;
        contextChunks.push(item);
        totalLen += chunkLen;
      }

      // 如果没有找到相关 chunk，回复得体
      if (contextChunks.length === 0) {
        return new Response(JSON.stringify({
          answer: '目前知识库中暂无与您问题直接相关的信息。建议您：\n\n1. 尝试换一种方式描述您的问题\n2. 直接联系 GZU Wellness Longevity Center 获取最新信息\n3. 预约一对一面诊咨询',
          sources: [],
          question: question,
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // 生成回答
      const systemPrompt = buildSystemPrompt(contextChunks);
      console.log(`Calling ${provider} API...`);

      const answer = await generateAnswer(apiKey, provider, systemPrompt, question);

      // 构建来源列表
      const sources = contextChunks.map(item => ({
        title: item.chunk.title,
        relevance: Math.round(item.score * 100) / 100,
      }));

      return new Response(JSON.stringify({
        answer,
        sources,
        question,
        chunks_used: contextChunks.length,
      }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({
        error: `处理请求时出错: ${err.message}`,
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
