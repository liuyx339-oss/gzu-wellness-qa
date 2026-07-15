#!/bin/bash
# ============================================================
# GZU Wellness 知识库同步脚本
# 从飞书电子表格提取数据，转换为 Markdown，构建索引
#
# 环境变量要求:
#   FEISHU_APP_ID / FEISHU_APP_SECRET - 飞书应用凭据
#   OPENAI_API_KEY - OpenAI API Key（用于构建向量索引）
#
# 用法:
#   bash scripts/sync.sh
#   bash scripts/sync.sh --force
# ============================================================

set -euo pipefail

FORCE=${1:-}
DATA_DIR="data/docs"
CHUNKS_FILE="data/chunks.json"

echo "📚 GZU Wellness 知识库同步"
echo "============================"

# Check dependencies
command -v lark-cli >/dev/null 2>&1 || { echo "❌ 需要安装 lark-cli: npm install -g lark-cli"; exit 1; }

# Setup Python
PYTHON="${PYTHON:-python3}"
$PYTHON -c "import openai" 2>/dev/null || pip install openai tiktoken requests

# ----------------------------------------------------------
# Step 1: 从飞书表格提取数据
# ----------------------------------------------------------
echo ""
echo "📊 Step 1: 提取飞书表格数据..."

mkdir -p "$DATA_DIR"

# 来源配置（与 sync_feishu.py 的 PRESET_SOURCES 同步）
declare -A SOURCES=(
  ["Q&A与产品|FQXGsnr1Phz0j2tLibocjejjnof"]="https://h03iw32mvho.feishu.cn/sheets/FQXGsnr1Phz0j2tLibocjejjnof"
  ["价格总表|OSlZsGiqvhgPIBt7Gy8cUW2YnYe"]="https://h03iw32mvho.feishu.cn/sheets/OSlZsGiqvhgPIBt7Gy8cUW2YnYe"
  ["套餐目录|U7f5sfSzNhQFvutyrHUcI9X6nQd"]="https://h03iw32mvho.feishu.cn/sheets/U7f5sfSzNhQFvutyrHUcI9X6nQd"
)

for entry in "${!SOURCES[@]}"; do
  label="${entry%%|*}"
  token="${entry##*|}"
  url="${SOURCES[$entry]}"

  echo "  📋 $label ($token)"

  # 获取工作表列表
  sheets_json=$(lark-cli sheets +workbook-info --spreadsheet-token "$token" --as user 2>/dev/null)
  sheet_count=$(echo "$sheets_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',{}).get('sheets',[])))" 2>/dev/null || echo "0")
  echo "    发现 $sheet_count 个工作表"

  # 遍历每个工作表
  echo "$sheets_json" | python3 -c "
import sys, json, re, csv, io

data = json.load(sys.stdin)
sheets = data.get('data', {}).get('sheets', [])
for s in sheets:
    name = s.get('title', s.get('sheet_name', ''))
    sid = s.get('sheet_id', '')
    if not name or not sid:
        continue
    # 跳过二维码/图片工作表
    if any(kw in name for kw in ['二维码', 'QR', '海报']):
        print(f'    ⏭️ 跳过: {name}')
        continue
    # 输出 sheet 名和 id，供后续处理
    print(f'SHEET|{name}|{sid}')
" 2>/dev/null | while IFS='|' read -r _ name sid; do
    [ -z "$name" ] && continue
    safe_name=$(echo "$name" | sed 's/[^a-zA-Z0-9_一-龥()-]//g' | head -c 50)
    outfile="$DATA_DIR/${label}_${safe_name}.md"

    echo "    📥 $name → $outfile"
    lark-cli sheets +csv-get \
      --spreadsheet-token "$token" \
      --sheet-name "$name" \
      --as user 2>/dev/null | python3 -c "
import sys, json, csv, io

data = json.load(sys.stdin)
csv_text = data.get('data', {}).get('annotated_csv', '')
if not csv_text:
    sys.exit(0)

lines = csv_text.strip().split('\n')
if len(lines) < 2:
    sys.exit(0)

# 解析
rows = []
for line in lines:
    line = line.strip()
    if line.startswith('['):
        idx = line.index('] ')
        line = line[idx+2:]
    rows.append(list(csv.reader(io.StringIO(line)))[0])

if not rows:
    sys.exit(0)

title = '$safe_name'.replace('_', ' ')
outpath = '$DATA_DIR/${label}_${safe_name}.md'

# 判断是否Q&A格式
headers = [str(h).strip().lower() for h in rows[0]]
is_qa = any('question' in h or '问题' in h for h in headers) and \
        any('answer' in h or '回答' in h for h in headers)

with open(outpath, 'w', encoding='utf-8') as f:
    f.write(f'# {title}\n\n> 来源: ${url}\n\n')
    if is_qa:
        # Q&A 格式
        q_col = next(i for i,h in enumerate(headers) if 'question' in h or '问题' in h or h == 'q')
        a_col = next(i for i,h in enumerate(headers) if 'answer' in h or '回答' in h or h == 'a')
        count = 0
        for row in rows[1:]:
            q = str(row[q_col]).strip() if q_col < len(row) else ''
            a = str(row[a_col]).strip() if a_col < len(row) else ''
            if q and a:
                f.write(f'## Q: {q}\n\n{a}\n\n---\n')
                count += 1
        f.write(f'\n> 共 {count} 条问答\n')
    else:
        # 表格格式
        for i, row in enumerate(rows):
            f.write('| ' + ' | '.join(str(c).replace('\n','<br>') for c in row) + ' |\n')
            if i == 0:
                f.write('| ' + ' | '.join(['---']*len(row)) + ' |\n')
print('     ✅ 完成')
" 2>/dev/null || echo "     ⚠️ 跳过（无数据或格式异常）"
  done
done

# ----------------------------------------------------------
# Step 2: 构建文档索引
# ----------------------------------------------------------
echo ""
echo "🔍 Step 2: 构建文档索引..."

$PYTHON scripts/build_index.py --api-key "${OPENAI_API_KEY:-}" --docs-dir "$DATA_DIR" 2>&1 || {
  echo "⚠️ 索引构建失败（可能缺少 API Key），将使用纯文本 chunks"
  # 降级方案：直接从 Markdown 生成 chunks
  $PYTHON -c "
import json, re
from pathlib import Path

docs_dir = Path('$DATA_DIR')
chunks = []
for fp in sorted(docs_dir.glob('*.md')):
    text = fp.read_text(encoding='utf-8')
    doc_title = fp.stem
    # 按 ## 切分
    sections = re.split(r'\n(?=## )', text)
    for sec in sections:
        sec = sec.strip()
        if len(sec) > 50:
            chunks.append({'title': doc_title, 'content': sec[:2000]})

Path('$CHUNKS_FILE').write_text(
    json.dumps(chunks, ensure_ascii=False, indent=2), encoding='utf-8'
)
print(f'✅ 生成 {len(chunks)} 个 chunks')
" 2>/dev/null
}

# ----------------------------------------------------------
# Step 3: 统计
# ----------------------------------------------------------
echo ""
echo "📊 同步统计:"
echo "   文档文件: $(find "$DATA_DIR" -name '*.md' | wc -l) 个"
echo "   Chunks: $(python3 -c "import json; print(len(json.load(open('$CHUNKS_FILE', encoding='utf-8'))))" 2>/dev/null || echo 'N/A')"
echo ""
echo "🎉 同步完成！"
