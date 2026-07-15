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
const micBtn = document.getElementById('micBtn');
const chatArea = document.getElementById('chatArea');
const emptyState = document.getElementById('emptyState');
const loading = document.getElementById('loading');
const btnSettings = document.getElementById('btnSettings');
const btnAdd = document.getElementById('btnAdd');
const settingsPanel = document.getElementById('settingsPanel');
const addPanel = document.getElementById('addPanel');
const apiBadge = document.getElementById('apiBadge');
const apiProvider = document.getElementById('apiProvider');
const apiKeyInput = document.getElementById('apiKey');
const btnSave = document.getElementById('btnSave');
const btnClear = document.getElementById('btnClear');
// Add knowledge
const btnAddSave = document.getElementById('btnAddSave');
const addQuestion = document.getElementById('addQuestion');
const addAnswer = document.getElementById('addAnswer');
const addTitle = document.getElementById('addTitle');
const addContent = document.getElementById('addContent');
const addStatus = document.getElementById('addStatus');

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

// ===== Panel Toggle =====
btnSettings.addEventListener('click', () => {
  const isOpen = !settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden', isOpen);
  addPanel.classList.add('hidden');
});

btnAdd.addEventListener('click', () => {
  const isOpen = !addPanel.classList.contains('hidden');
  addPanel.classList.toggle('hidden', isOpen);
  settingsPanel.classList.add('hidden');
});

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

// Submit knowledge
btnAddSave.addEventListener('click', async () => {
  const activeTab = document.querySelector('.tab.active').dataset.tab;
  let body;

  if (activeTab === 'qa') {
    const q = addQuestion.value.trim();
    const a = addAnswer.value.trim();
    if (!q || !a) { addStatus.className = 'add-status error'; addStatus.textContent = '请填写问题和答案'; return; }
    body = { type: 'qa', question: q, answer: a };
  } else {
    const c = addContent.value.trim();
    if (!c) { addStatus.className = 'add-status error'; addStatus.textContent = '请填写知识内容'; return; }
    body = { type: 'text', title: addTitle.value.trim() || '用户添加', content: c };
  }

  btnAddSave.disabled = true;
  addStatus.className = 'add-status';
  addStatus.textContent = '⏳ 正在提交...';

  try {
    const resp = await fetch(`${WORKER_URL}/api/add-knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      addStatus.className = 'add-status success';
      addStatus.textContent = '✅ ' + data.message;

      // Clear form
      if (activeTab === 'qa') { addQuestion.value = ''; addAnswer.value = ''; }
      else { addTitle.value = ''; addContent.value = ''; }
    } else {
      throw new Error(data.error || '提交失败');
    }
  } catch (err) {
    addStatus.className = 'add-status error';
    addStatus.textContent = '❌ ' + err.message;
  } finally {
    btnAddSave.disabled = false;
  }
});

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

// ===== Voice Input (纯浏览器端 sherpa-onnx，零API依赖) =====
let isRecording = false;
let audioCtx = null;
let mediaStream = null;
let sherpaRecognizer = null;
let sherpaStream = null;
let sherpaStatus = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'

async function loadSherpa() {
  if (sherpaStatus === 'ready') return true;
  if (sherpaStatus === 'loading') return false;

  sherpaStatus = 'loading';
  micBtn.textContent = '📥';
  micBtn.disabled = true;
  micBtn.title = '正在下载语音模型(约25MB，仅首次)...';

  try {
    const { createOnlineRecognizer, OnlineRecognizer } = await import(
      'https://cdn.jsdelivr.net/npm/sherpa-onnx@2.1.18/wasm/sherpa-onnx-asr.js'
    );

    const base = 'https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-zh-14m-2023-02-23/resolve/main';

    sherpaRecognizer = createOnlineRecognizer(
      {
        modelConfig: {
          transducer: {
            encoder: base + '/encoder-epoch-99-avg-1.onnx',
            decoder: base + '/decoder-epoch-99-avg-1.onnx',
            joiner: base + '/joiner-epoch-99-avg-1.onnx',
          },
          tokens: base + '/tokens.txt',
          modelType: 'zipformer2',
        },
        enableEndpoint: 1,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20.0,
      },
    );

    sherpaStream = sherpaRecognizer.createStream();
    sherpaStatus = 'ready';

    micBtn.textContent = '🎤';
    micBtn.disabled = false;
    micBtn.title = '语音输入';
    return true;

  } catch (err) {
    console.error('Sherpa load:', err);
    sherpaStatus = 'error';
    micBtn.textContent = '⚠️';
    micBtn.disabled = false;
    micBtn.title = '加载失败，点击重试';
    alert('语音模型加载失败（可能网络问题），请稍后重试');
    return false;
  }
}

micBtn.addEventListener('click', async () => {
  // 加载模型
  if (sherpaStatus === 'error') sherpaStatus = 'idle';
  if (sherpaStatus !== 'ready') {
    const ok = await loadSherpa();
    if (!ok) return;
  }

  if (isRecording) {
    // 停止录音
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎤';
    isRecording = false;

    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }

    // 获取最终结果
    if (sherpaRecognizer && sherpaStream) {
      sherpaRecognizer.inputFinished(sherpaStream);
      while (sherpaRecognizer.isReady(sherpaStream)) {
        sherpaRecognizer.decode(sherpaStream);
      }
      const result = sherpaRecognizer.getResult(sherpaStream);
      if (result?.text) questionInput.value = result.text;
      sherpaStream = sherpaRecognizer.createStream();
    }
    return;
  }

  // 开始录音
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(mediaStream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioCtx.destination);

    processor.onaudioprocess = (event) => {
      if (!isRecording || sherpaStatus !== 'ready') return;
      const input = event.inputBuffer.getChannelData(0);
      // sherpa-onnx accepts Float32Array
      sherpaRecognizer.acceptWaveform(sherpaStream, 16000, input);

      // 实时识别
      while (sherpaRecognizer.isReady(sherpaStream)) {
        sherpaRecognizer.decode(sherpaStream);
      }
      const r = sherpaRecognizer.getResult(sherpaStream);
      if (r?.text) questionInput.value = r.text;
    };

    window._vp = processor;
    window._vs = source;

    micBtn.classList.add('recording');
    micBtn.textContent = '🔴';
    isRecording = true;

  } catch (err) {
    if (err.name === 'NotAllowedError') {
      alert('请允许浏览器使用麦克风\n点击地址栏左侧锁图标 → 网站设置 → 允许麦克风');
    } else {
      alert('麦克风失败: ' + err.message);
    }
  }
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
