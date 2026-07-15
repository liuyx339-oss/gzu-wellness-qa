/**
 * AI 知识库问答 — 前端交互逻辑
 */

const WORKER_URL = 'https://gzu-wellness-qa.gzu-wellness.workers.dev';

// ===== LocalStorage Key =====
const STORAGE_KEY = 'gzu_wellness_qa_config';

// ===== Config =====
function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function getConfig() {
  const cfg = loadConfig();
  return {
    apiKey: cfg.apiKey || '',
    provider: cfg.provider || 'deepseek',
  };
}

// ===== DOM =====
const questionInput = document.getElementById('questionInput');
const askBtn = document.getElementById('askBtn');
const chatArea = document.getElementById('chatArea');
const emptyState = document.getElementById('emptyState');
const loading = document.getElementById('loading');
const btnSettings = document.getElementById('btnSettings');
const settingsPanel = document.getElementById('settingsPanel');
const apiBadge = document.getElementById('apiBadge');
const apiProvider = document.getElementById('apiProvider');
const apiKeyInput = document.getElementById('apiKey');
const btnSave = document.getElementById('btnSave');
const btnClear = document.getElementById('btnClear');

// ===== Settings UI =====
function updateBadge() {
  const { apiKey } = getConfig();
  apiBadge.style.display = apiKey ? 'inline' : 'none';
}

function syncFormFromConfig() {
  const { apiKey, provider } = getConfig();
  apiKeyInput.value = apiKey;
  apiProvider.value = provider;
  // Show/hide provider links
  document.querySelectorAll('.provider-link').forEach(link => {
    link.style.display = link.dataset.provider === provider ? 'inline' : 'none';
  });
}

btnSettings.addEventListener('click', () => {
  const isOpen = !settingsPanel.classList.contains('hidden');
  if (isOpen) {
    settingsPanel.classList.add('hidden');
  } else {
    syncFormFromConfig();
    settingsPanel.classList.remove('hidden');
  }
});

apiProvider.addEventListener('change', () => {
  const provider = apiProvider.value;
  document.querySelectorAll('.provider-link').forEach(link => {
    link.style.display = link.dataset.provider === provider ? 'inline' : 'none';
  });
});

btnSave.addEventListener('click', () => {
  saveConfig({
    apiKey: apiKeyInput.value.trim(),
    provider: apiProvider.value,
  });
  settingsPanel.classList.add('hidden');
  updateBadge();
});

btnClear.addEventListener('click', () => {
  if (confirm('确定要清除已保存的 API Key 吗？')) {
    localStorage.removeItem(STORAGE_KEY);
    apiKeyInput.value = '';
    updateBadge();
  }
});

// ===== Event Listeners =====
askBtn.addEventListener('click', handleAsk);
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleAsk();
  }
});

questionInput.addEventListener('input', () => {
  questionInput.style.height = 'auto';
  questionInput.style.height = Math.min(questionInput.scrollHeight, 120) + 'px';
});

document.querySelectorAll('.example').forEach(el => {
  el.addEventListener('click', () => {
    questionInput.value = el.dataset.question;
    handleAsk();
  });
});

// ===== Init =====
updateBadge();

// ===== Core Logic =====
async function handleAsk() {
  const question = questionInput.value.trim();
  if (!question) return;

  const { apiKey, provider } = getConfig();
  if (!apiKey) {
    // Show settings panel if no API key
    settingsPanel.classList.remove('hidden');
    syncFormFromConfig();
    apiKeyInput.focus();
    renderError(question, '请先配置 API Key（点击右上角齿轮图标）');
    return;
  }

  questionInput.value = '';
  questionInput.style.height = 'auto';
  askBtn.disabled = true;
  emptyState.classList.add('hidden');
  loading.classList.remove('hidden');

  try {
    const response = await fetch(`${WORKER_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, apiKey, provider }),
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

  const qBubble = document.createElement('div');
  qBubble.className = 'question-bubble';
  qBubble.textContent = question;

  const aCard = document.createElement('div');
  aCard.className = 'answer-card';

  const content = document.createElement('div');
  content.className = 'answer-content';
  content.innerHTML = marked.parse(data.answer || '未能生成回答。');
  aCard.appendChild(content);

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
      item.innerHTML = `<span class="source-icon">📄</span>
        <span class="source-text" title="${escapeHtml(src.title || '')}">${escapeHtml(src.title || '知识库文档')}</span>
        ${src.relevance ? `<span class="source-relevance">${Math.round(src.relevance * 100)}%</span>` : ''}`;
      sourcesDiv.appendChild(item);
    });

    aCard.appendChild(sourcesDiv);
  }

  card.appendChild(qBubble);
  card.appendChild(aCard);
  chatArea.prepend(card);
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
    <button class="retry-btn" id="retryBtn-${Date.now()}">🔄 重试</button>
  `;
  errCard.querySelector('.retry-btn').addEventListener('click', () => {
    card.remove();
    questionInput.value = question;
    handleAsk();
  });

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
