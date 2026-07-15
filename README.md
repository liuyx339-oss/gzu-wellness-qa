# 🤖 GZU Wellness AI 知识库问答

基于飞书文档的智能问答网站，部署在 GitHub Pages，所有人均可访问。用户输入问题，AI 根据知识库内容实时生成专业回答。

## ✨ 功能

- 🔍 **智能检索**：输入问题，自动从知识库找到最相关的内容
- 💬 **AI 回答**：基于 Claude/GPT 实时生成专业、温暖的中文回答
- 📖 **来源追溯**：每条回答附带参考文档来源和相关性评分
- 🔄 **每日同步**：GitHub Actions 每天自动从飞书表格更新知识库
- 📱 **响应式**：手机和桌面端都能流畅使用
- 💰 **低成本**：全部使用免费/按量付费服务

## 🏗 架构

```
用户浏览器 ──→ GitHub Pages (index.html)
                   │ POST /api/ask
                   ▼
           Cloudflare Worker (worker/index.js)
              │                   │
              ▼                   ▼
        AI API (GPT/Claude)   知识库 (data/chunks.json)
                                   ▲
                            GitHub Actions (每日同步)
                                   ▲
                             飞书电子表格 (4个数据源)
```

## 📦 项目结构

```
knowledge-base-qa/
├── index.html              # 前端主页面
├── styles.css              # 样式
├── app.js                  # 前端交互逻辑
├── data/
│   ├── docs/               # 飞书同步的 Markdown 文档
│   │   ├── qa_常见问题.md    # 核心 Q&A
│   │   └── catalog_服务项目.md # 产品目录
│   └── chunks.json         # 文档索引（供 Worker 检索）
├── worker/
│   ├── index.js            # Cloudflare Worker (API 代理)
│   └── wrangler.toml       # Worker 配置
├── scripts/
│   ├── sync.sh             # 飞书数据同步脚本 (bash + lark-cli)
│   ├── sync_feishu.py      # 飞书数据同步脚本 (Python 版)
│   ├── build_index.py      # 文档索引构建脚本
│   └── requirements.txt    # Python 依赖
├── .github/
│   └── workflows/
│       └── daily-sync.yml  # GitHub Actions 定时同步
└── README.md               # 本文件
```

## 🚀 快速部署

### 1. 准备工作

你需要：
- **GitHub 账号**（创建公开仓库）
- **Cloudflare 账号**（免费，用于部署 Worker）
- **AI API Key**（OpenAI 或 Anthropic）

可选：
- 飞书应用凭据（已有内置凭据，通常不需额外配置）

### 2. 创建 GitHub 仓库

```bash
# 克隆本项目或创建新仓库
git init
git add .
git commit -m "初始版本"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/gzu-wellness-qa.git
git push -u origin main
```

### 3. 开启 GitHub Pages

在仓库 Settings → Pages → Source 选 `main` 分支 → Save

### 4. 配置 GitHub Secrets

在仓库 Settings → Secrets and variables → Actions → New repository secret：

| Secret 名称 | 说明 | 必填 |
|---|---|---|
| `FEISHU_APP_ID` | 飞书应用 ID | 否（有默认值） |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | 否（有默认值） |
| `OPENAI_API_KEY` | AI API Key | 否（仅用于索引） |

### 5. 部署 Cloudflare Worker

```bash
# 安装 Wrangler
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 进入 worker 目录
cd worker

# 修改 wrangler.toml 中的 CHUNKS_URL
# 将 YOUR_USERNAME/YOUR_REPO 替换为你的 GitHub 仓库路径

# 设置 AI API Key（加密存储）
wrangler secret put AI_API_KEY

# 部署
wrangler deploy
```

### 6. 更新前端配置

修改 [app.js](app.js) 第 6 行的 `WORKER_URL`：
```js
const WORKER_URL = 'https://gzu-wellness-qa.YOUR_SUBDOMAIN.workers.dev';
```

提交并推送，部署完成！🎉

## 🔧 数据源

知识库数据来自以下飞书电子表格：

| 来源 | 链接 | 内容 |
|---|---|---|
| Q&A | `FQXGsnr1Phz0j2tLibocjejjnof` | 常见问答（27条） |
| 价格 | `OSlZsGiqvhgPIBt7Gy8cUW2YnYe` | 价格总表与促销 |
| 套餐 | `U7f5sfSzNhQFvutyrHUcI9X6nQd` | 完整套餐目录（28个工作表） |
| 官网 | gzu-wellness-longevity-center.com | 网站内容 |

数据通过 GitHub Actions 每天自动同步，也可手动触发。

## 💡 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | HTML/CSS/JS + marked.js | 零依赖构建 |
| API 代理 | Cloudflare Workers | 免费 10 万请求/天 |
| AI 对话 | DeepSeek (deepseek-chat) / GPT-4o-mini / Claude Sonnet | 按 token 付费 |
| 检索 | 关键词 Jaccard 相似度 | 无需额外 embedding 费用 |
| 数据同步 | lark-cli + Python | GitHub Actions ubuntu runner |
| 定时任务 | GitHub Actions cron | 免费（公开仓库） |

## 🤔 常见问题

**Q: 为什么不用 embedding 向量检索？**
A: 对 50-200 篇文档的知识库，关键词匹配的准确度已经足够。embedding 方案会增加每次查询的 API 调用费用。如需更好的检索效果，可修改 Worker 接入 embedding API。

**Q: 如何更新知识库内容？**
A: 在飞书表格中修改内容后，GitHub Actions 会在次日自动同步。也可以在 Actions 页面手动触发 `workflow_dispatch`。

**Q: 支持哪些 AI 模型？**
A: 默认使用 OpenAI GPT-4o-mini（性价比最高）。修改 Worker 环境变量 `AI_PROVIDER` 可切换为 Anthropic Claude。修改 Worker 代码中的 model 参数可切换具体模型。

**Q: 如何添加新的数据源？**
A: 编辑 `scripts/sync.sh` 中的 `SOURCES` 配置，添加新的飞书表格 URL 即可。同时也更新 `scripts/sync_feishu.py` 的 `PRESET_SOURCES`。

## 📄 许可

MIT
