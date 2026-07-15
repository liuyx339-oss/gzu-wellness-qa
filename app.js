/**
 * AI 知识库问答 — 前端交互逻辑
 *
 * 配置：部署前修改 WORKER_URL 为你的 Cloudflare Worker 地址
 */
const WORKER_URL = 'https://your-worker.your-subdomain.workers.dev';

// ===== DOM Elements =====
const questionInput = document.getElementById('questionInput');
const askBtn = document.getElementById('askBtn');
const chatArea = document.getElementById('chatArea');
const emptyState = document.getElementById('emptyState');
const loading = document.getElementById('loading');
const searchSection = document.getElementById('searchSection');

// ===== Event Listeners =====
askBtn.addEventListener('click', handleAsk);
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleAsk();
  }
});

// Auto-resize textarea
questionInput.addEventListener('input', () => {
  questionInput.style.height = 'auto';
  questionInput.style.height = Math.min(questionInput.scrollHeight, 120) + 'px';
});

// Click example questions
document.querySelectorAll('.example').forEach(el => {
  el.addEventListener('click', () => {
    questionInput.value = el.dataset.question;
    handleAsk();
  });
});

// ===== Core Logic =====
async function handleAsk() {
  const question = questionInput.value.trim();
  if (!question) return;

  // Reset UI
  questionInput.value = '';
  questionInput.style.height = 'auto';
  askBtn.disabled = true;
  emptyState.classList.add('hidden');
  loading.classList.remove('hidden');

  try {
    const response = await fetch(`${WORKER_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `请求失败 (${response.status})`);
    }

    const data = await response.json();
    renderAnswer(question, data);
  } catch (err) {
    renderError(question, err.message);
  } finally {
    loading.classList.add('hidden');
    askBtn.disabled = false;
    questionInput.focus();
  }
}

// ===== Render =====
function renderAnswer(question, data) {
  const card = document.createElement('div');
  card.className = 'qa-card';

  // Question bubble
  const qBubble = document.createElement('div');
  qBubble.className = 'question-bubble';
  qBubble.textContent = question;

  // Answer card
  const aCard = document.createElement('div');
  aCard.className = 'answer-card';

  // Answer content (markdown)
  const content = document.createElement('div');
  content.className = 'answer-content';
  content.innerHTML = marked.parse(data.answer || '未能生成回答。');

  aCard.appendChild(content);

  // Sources
  if (data.sources && data.sources.length > 0) {
    const sourcesDiv = document.createElement('div');
    sourcesDiv.className = 'sources';

    const sourcesTitle = document.createElement('div');
    sourcesTitle.className = 'sources-title';
    sourcesTitle.textContent = `📖 参考来源 (${data.sources.length})`;
    sourcesDiv.appendChild(sourcesTitle);

    data.sources.forEach(src => {
      const item = document.createElement('div');
      item.className = 'source-item';

      const icon = document.createElement('span');
      icon.className = 'source-icon';
      icon.textContent = '📄';

      const text = document.createElement('span');
      text.className = 'source-text';
      text.textContent = src.title || '知识库文档';
      text.title = src.title;

      if (src.relevance) {
        const relevance = document.createElement('span');
        relevance.className = 'source-relevance';
        relevance.textContent = `${Math.round(src.relevance * 100)}%`;
        item.appendChild(icon);
        item.appendChild(text);
        item.appendChild(relevance);
      } else {
        item.appendChild(icon);
        item.appendChild(text);
      }

      sourcesDiv.appendChild(item);
    });

    aCard.appendChild(sourcesDiv);
  }

  card.appendChild(qBubble);
  card.appendChild(aCard);
  chatArea.prepend(card); // Newest on top

  // Scroll to top of chat area
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderError(question, message) {
  const card = document.createElement('div');
  card.className = 'qa-card';

  const qBubble = document.createElement('div');
  qBubble.className = 'question-bubble';
  qBubble.textContent = question;

  const errCard = document.createElement('div');
  errCard.className = 'error-card';
  errCard.innerHTML = `
    <strong>⚠️ 出错了</strong>
    <p style="margin-top:4px;">${escapeHtml(message)}</p>
    <button class="retry-btn" onclick="this.closest('.qa-card').remove(); questionInput.value='${escapeHtml(question)}'; handleAsk();">🔄 重试</button>
  `;

  card.appendChild(qBubble);
  card.appendChild(errCard);
  chatArea.prepend(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
