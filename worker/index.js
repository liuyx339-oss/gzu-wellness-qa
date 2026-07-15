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
const DEEPSEEK_MODEL = 'deepseek-chat';  // 或 'deepseek-reasoner' (R1)
const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// 知识库 chunks 的 GitHub raw URL
// 格式: https://raw.githubusercontent.com/{owner}/{repo}/main/data/chunks.json
const CHUNKS_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/data/chunks.json';

// 检索参数
const TOP_K = 5;        // 每次检索最相关的 K 个 chunks
const MAX_CONTEXT = 8000; // 最大上下文字符数

// ============================================================
// 文本相似度计算（基于关键词 Jaccard + TF 的简单检索）
// ============================================================

/**
 * 中文分词（简单实现：按常见词边界切分）
 */
function tokenize(text) {
  // 移除 Markdown 标记和标点
  const cleaned = text
    .replace(/[#*_~`>|-]/g, ' ')
    .replace(/[，。！？、；：""''（）【】《》\s]+/g, ' ')
    .trim()
    .toLowerCase();

  // 提取中文词组（2-4字）和英文单词
  const tokens = [];
  const words = cleaned.split(/\s+/);

  for (const word of words) {
    if (/^[a-z]+$/.test(word)) {
      // 英文单词直接加入
      if (word.length > 1) tokens.push(word);
    } else {
      // 中文：按 bigram 切分
      for (let i = 0; i < word.length - 1; i++) {
        tokens.push(word.substring(i, i + 2));
      }
    }
  }

  return tokens;
}

/**
 * 计算两个文本的 Jaccard 相似度
 */
function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 检索最相关的 K 个 chunks
 */
function searchChunks(question, chunks, topK = TOP_K) {
  const questionTokens = tokenize(question);

  const scored = chunks.map((chunk, index) => {
    const chunkTokens = tokenize(chunk.content);
    const titleTokens = tokenize(chunk.title);

    // 综合得分：内容相似度 + 标题相似度（标题权重更高）
    const contentScore = jaccardSimilarity(questionTokens, chunkTokens);
    const titleScore = jaccardSimilarity(questionTokens, titleTokens) * 2.0;
    const score = contentScore + titleScore;

    return { index, chunk, score };
  });

  // 排序并取 top-K
  scored.sort((a, b) => b.score - a.score);

  // 过滤掉零分项
  return scored
    .filter(item => item.score > 0)
    .slice(0, topK);
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
const CACHE_TTL = 3600 * 1000; // 1小时缓存

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

    // 只处理 /api/ask
    const url = new URL(request.url);
    if (url.pathname !== '/api/ask' || request.method !== 'POST') {
      return new Response(JSON.stringify({
        error: '请使用 POST /api/ask',
        usage: { question: '你的问题' },
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
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

      // 检查 API Key 配置
      const apiKey = env.AI_API_KEY;
      const provider = env.AI_PROVIDER || AI_PROVIDER;

      if (!apiKey) {
        return new Response(JSON.stringify({
          error: 'AI API Key 未配置，请联系管理员',
        }), {
          status: 500,
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
