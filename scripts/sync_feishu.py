#!/usr/bin/env python3
"""
知识库数据同步脚本

从多个来源拉取知识库内容，转换为 Markdown 存入本地。
来源支持：飞书电子表格（Q&A）、飞书 Wiki/Docx、外部网站。

用法:
  # 从飞书电子表格提取 Q&A
  python sync_feishu.py --sheet-url "https://xxx.feishu.cn/sheets/TOKEN" --sheet-name "常见Q&A"

  # 从飞书知识库同步
  python sync_feishu.py --space-id <wiki_space_id>

  # 从多个来源同步
  python sync_feishu.py --config sources.json

凭据优先级: 命令行参数 > 环境变量 > 默认值
  - FEISHU_APP_ID / FEISHU_APP_SECRET
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

import requests

# 修复 Windows console GBK 编码问题
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ============================================================
# 配置
# ============================================================
DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "docs"
META_FILE = Path(__file__).resolve().parent.parent / "data" / "sync_meta.json"

# 默认凭据
DEFAULT_APP_ID = os.environ.get("FEISHU_APP_ID", "")
DEFAULT_APP_SECRET = os.environ.get("FEISHU_APP_SECRET", "")

# 预设数据源配置
# type: "sheet-qa" = Q&A格式(Question+Answer列), "sheet-table" = 普通表格,
#       "spreadsheet" = 整表自动发现, "website" = 网站抓取
PRESET_SOURCES = [
    # 来源1: 网站
    {"type": "website", "url": "https://gzu-wellness-longevity-center.com",
     "title": "GZU Wellness 官网", "output": "website_官网.md"},

    # 来源2: 飞书表格 - Q&A + 服务项目
    {"type": "spreadsheet",
     "url": "https://h03iw32mvho.feishu.cn/sheets/FQXGsnr1Phz0j2tLibocjejjnof",
     "token": "FQXGsnr1Phz0j2tLibocjejjnof",
     "label": "Q&A与产品"},

    # 来源3: 飞书表格 - 价格总表
    {"type": "spreadsheet",
     "url": "https://h03iw32mvho.feishu.cn/sheets/OSlZsGiqvhgPIBt7Gy8cUW2YnYe",
     "token": "OSlZsGiqvhgPIBt7Gy8cUW2YnYe",
     "label": "价格总表"},

    # 来源4: 飞书表格 - 完整套餐目录(28 sheets)
    {"type": "spreadsheet",
     "url": "https://h03iw32mvho.feishu.cn/sheets/U7f5sfSzNhQFvutyrHUcI9X6nQd",
     "token": "U7f5sfSzNhQFvutyrHUcI9X6nQd",
     "label": "套餐目录"},
]

# ============================================================
# 飞书 API 客户端
# ============================================================

class FeishuClient:
    """飞书 Open API 客户端（通过 lark-cli 或直接 API）"""

    def __init__(self, app_id: str, app_secret: str):
        self.app_id = app_id
        self.app_secret = app_secret

    def get_sheet_meta(self, spreadsheet_token: str) -> dict:
        """通过 lark-cli 获取电子表格元数据"""
        import subprocess
        result = subprocess.run(
            ["lark-cli", "sheets", "+workbook-info",
             "--spreadsheet-token", spreadsheet_token,
             "--as", "bot"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"lark-cli 失败: {result.stderr}")
        data = json.loads(result.stdout)
        return data.get("data", data)


# ============================================================
# 数据提取与转换
# ============================================================

def _run_larkcli(args: list, timeout: int = 30) -> dict:
    """运行 lark-cli 并返回 JSON 数据"""
    import subprocess
    cmd = ["lark-cli"] + args + ["--as", "user"]
    # Windows needs shell=True to find lark-cli via bash
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        shell=(sys.platform == "win32"),
    )
    if result.returncode != 0:
        raise RuntimeError(f"lark-cli 失败: {result.stderr.strip()}")
    return json.loads(result.stdout)


def extract_sheet_csv(spreadsheet_token: str, sheet_name: str) -> tuple:
    """通过 lark-cli 读取表格 CSV 数据，返回 (headers, rows)"""
    print(f"  📊 读取表格: {sheet_name}")
    data = _run_larkcli([
        "sheets", "+csv-get",
        "--spreadsheet-token", spreadsheet_token,
        "--sheet-name", sheet_name,
    ])
    csv_text = data.get("data", {}).get("annotated_csv", "")
    if not csv_text:
        return [], []

    # 解析 annotated_csv 格式: "[row=N] col1,col2,..."
    lines = csv_text.strip().split("\n")
    if not lines:
        return [], []

    rows = []
    for line in lines:
        line = line.strip()
        # 去掉 [row=N] 前缀
        if line.startswith("["):
            idx = line.index("] ")
            line = line[idx + 2:]
        rows.append(list(csv.reader(io.StringIO(line)))[0])

    if not rows:
        return [], []

    return rows[0], rows[1:]  # headers, data rows


def extract_qa_from_sheet(client: FeishuClient, spreadsheet_token: str,
                          sheet_name: str) -> list[dict]:
    """从飞书表格提取 Q&A 数据"""
    headers, data_rows = extract_sheet_csv(spreadsheet_token, sheet_name)

    if not headers:
        print(f"  ⚠️ 表格为空或只有表头")
        return []

    # 查找 Q/A 列
    q_col = a_col = None
    for i, h in enumerate(headers):
        h_clean = str(h).strip().lower() if h else ""
        if any(kw in h_clean for kw in ["question", "问题", "q"]):
            q_col = i
        elif any(kw in h_clean for kw in ["answer", "回答", "答案", "a"]):
            a_col = i

    if q_col is None and a_col is None:
        q_col, a_col = 0, 1
        print(f"  ℹ️ 未找到 Q/A 表头，使用第1列=问题，第2列=回答")

    qa_pairs = []
    for row in data_rows:
        q = str(row[q_col]).strip() if q_col < len(row) else ""
        a = str(row[a_col]).strip() if a_col < len(row) else ""
        if q and a:
            qa_pairs.append({"question": q, "answer": a})

    print(f"  ✅ 提取 {len(qa_pairs)} 对 Q&A")
    return qa_pairs


def extract_table_from_sheet(client: FeishuClient, spreadsheet_token: str,
                             sheet_name: str) -> list[dict]:
    """从表格提取结构化数据"""
    headers, data_rows = extract_sheet_csv(spreadsheet_token, sheet_name)

    if not headers:
        return []

    rows = []
    for row in data_rows:
        r = {}
        for i, h in enumerate(headers):
            r[str(h).strip()] = str(row[i]).strip() if i < len(row) and row[i] else ""
        if any(v for v in r.values()):
            rows.append(r)

    print(f"  ✅ 提取 {len(rows)} 行数据")
    return rows


def scrape_website(url: str) -> str:
    """抓取网站文本内容"""
    print(f"  🌐 抓取网站: {url}")
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/120.0.0.0 Safari/537.36"
        }
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        resp.encoding = resp.apparent_encoding

        # 简单的 HTML 到文本转换
        html = resp.text
        # 移除 script/style
        html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.I)
        html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.I)
        # 移除 HTML 标签
        text = re.sub(r'<[^>]+>', ' ', html)
        # 清理空白
        text = re.sub(r'\s+', ' ', text).strip()
        # 解码 HTML 实体
        text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
        text = text.replace('&quot;', '"').replace('&#39;', "'").replace('&nbsp;', ' ')

        print(f"  ✅ 抓取 {len(text)} 字符")
        return text
    except Exception as e:
        print(f"  ❌ 抓取失败: {e}")
        return ""


# ============================================================
# Markdown 生成
# ============================================================

def qa_to_markdown(qa_pairs: list[dict], title: str) -> str:
    """将 Q&A 列表转换为 Markdown"""
    lines = [f"# {title}\n"]
    lines.append(f"> 共 {len(qa_pairs)} 条常见问题与解答\n")
    for i, qa in enumerate(qa_pairs, 1):
        lines.append(f"## Q{i}: {qa['question']}\n")
        lines.append(f"{qa['answer']}\n")
        lines.append("---\n")
    return "\n".join(lines)


def table_to_markdown(rows: list[dict], title: str) -> str:
    """将结构化数据转为 Markdown 表格 + 详情"""
    lines = [f"# {title}\n"]
    if not rows:
        lines.append("（暂无数据）\n")
        return "\n".join(lines)

    # 表格部分
    headers = list(rows[0].keys())
    # 只保留有内容的列
    active_headers = [h for h in headers if any(r.get(h) for r in rows)]
    lines.append("| " + " | ".join(active_headers) + " |")
    lines.append("| " + " | ".join(["---"] * len(active_headers)) + " |")
    for row in rows:
        vals = [row.get(h, "").replace("\n", "<br>") for h in active_headers]
        lines.append("| " + " | ".join(vals) + " |")

    # 也输出详情
    lines.append("\n## 详细说明\n")
    for row in rows:
        name = row.get(active_headers[0], "") if active_headers else ""
        if name:
            lines.append(f"### {name}\n")
            for k, v in row.items():
                if k != active_headers[0] and v:
                    lines.append(f"- **{k}**: {v}")
            lines.append("")

    return "\n".join(lines)


# ============================================================
# 文件管理
# ============================================================

def load_meta() -> dict:
    if META_FILE.exists():
        return json.loads(META_FILE.read_text(encoding="utf-8"))
    return {"documents": {}}


def save_meta(meta: dict):
    META_FILE.parent.mkdir(parents=True, exist_ok=True)
    META_FILE.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def hash_content(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def write_doc(filename: str, content: str, meta: dict, source_info: dict):
    """写入文档并更新元数据"""
    filepath = DATA_DIR / filename
    filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.write_text(content, encoding="utf-8")

    doc_hash = hash_content(content)
    key = source_info.get("key", filename)
    meta["documents"][key] = {
        "filename": filename,
        "hash": doc_hash,
        **source_info,
    }
    print(f"  💾 保存: {filename} ({len(content):,} 字符)")


# ============================================================
# 同步入口
# ============================================================

def sync_spreadsheet_all(client: FeishuClient, spreadsheet_token: str,
                         url: str, label: str, meta: dict) -> int:
    """自动发现并同步电子表格的所有工作表"""
    print(f"\n📊 同步整表 [{label}]: {url}")

    # 获取工作表列表
    try:
        sheet_meta = client.get_sheet_meta(spreadsheet_token)
    except Exception as e:
        print(f"  ❌ 获取表格元数据失败: {e}")
        return 0

    sheets = sheet_meta.get("sheets", [])
    print(f"  📋 发现 {len(sheets)} 个工作表")

    count = 0
    for sheet_info in sheets:
        sheet_name = sheet_info.get("title", sheet_info.get("sheet_name", ""))
        sheet_id = sheet_info.get("sheet_id", "")
        if not sheet_name or not sheet_id:
            continue

        # 跳过明显是图片/二维码的工作表
        if any(kw in sheet_name.lower() for kw in ["二维码", "qr"]):
            print(f"  ⏭️ 跳过: {sheet_name}")
            continue

        # 清理文件名
        safe_name = re.sub(r'[\\/*?:"<>|]', '', sheet_name)
        safe_name = safe_name.replace(' ', '_')[:80]
        filename = f"{label}_{safe_name}.md"

        try:
            # 先读数据判断格式
            csv_data = _run_larkcli([
                "sheets", "+csv-get",
                "--spreadsheet-token", spreadsheet_token,
                "--sheet-name", sheet_name,
            ])
            csv_text = csv_data.get("data", {}).get("annotated_csv", "")

            if not csv_text:
                print(f"  ⏭️ {sheet_name}: 空表")
                continue

            lines = csv_text.strip().split("\n")
            body_lines = [l for l in lines if l.strip()]
            if len(body_lines) <= 1:
                print(f"  ⏭️ {sheet_name}: 无数据")
                continue

            # 解析第一行作为表头
            first_line = body_lines[0]
            if first_line.startswith("["):
                first_line = first_line[first_line.index("] ") + 2:]
            headers = [str(h).strip().lower() if h else ""
                       for h in list(csv.reader(io.StringIO(first_line)))[0]]

            # 判断是否为 Q&A 格式
            is_qa = any(
                kw in h for h in headers
                for kw in ["question", "问题", "q", "提问"]
            ) and any(
                kw in h for h in headers
                for kw in ["answer", "回答", "答案", "a"]
            )

            if is_qa:
                qa_pairs = extract_qa_from_sheet(
                    client, spreadsheet_token, sheet_name
                )
                if qa_pairs:
                    md = qa_to_markdown(qa_pairs, sheet_name)
                else:
                    continue
            else:
                rows = extract_table_from_sheet(
                    client, spreadsheet_token, sheet_name
                )
                if not rows:
                    continue
                md = table_to_markdown(rows, sheet_name)

            write_doc(filename, md, meta, {
                "type": "sheet-qa" if is_qa else "sheet-table",
                "source_url": url,
                "sheet_name": sheet_name,
                "key": f"auto:{spreadsheet_token}:{sheet_name}",
            })
            count += 1

        except Exception as e:
            print(f"  ❌ {sheet_name} 失败: {e}")
            continue

    return count


def sync_preset(client: FeishuClient, preset_name: str, meta: dict) -> int:
    """同步预设数据源（兼容旧用法）"""
    # 查找匹配的预设源
    matching = [s for s in PRESET_SOURCES if s.get("label") == preset_name]
    if not matching:
        print(f"❌ 未知预设: {preset_name}")
        return 0
    return sync_all_sources(client, matching, meta)


def sync_all_sources(client: FeishuClient, sources: list, meta: dict) -> int:
    """同步所有数据源"""
    total = 0
    for src in sources:
        stype = src.get("type", "")
        try:
            if stype == "spreadsheet":
                total += sync_spreadsheet_all(
                    client, src["token"], src["url"],
                    src.get("label", "sheet"), meta,
                )
            elif stype == "website":
                total += sync_website(
                    src["url"], src.get("title", "网站"),
                    src.get("output", "website.md"), meta,
                )
        except Exception as e:
            print(f"  ❌ 来源 [{src.get('label', src.get('url', 'unknown'))}] 同步失败: {e}")
    return total


def sync_website(url: str, title: str, filename: str, meta: dict) -> int:
    """同步网站内容"""
    print(f"\n🌐 同步网站: {title}")
    text = scrape_website(url)
    if not text:
        return 0

    md = f"# {title}\n\n> 来源: {url}\n\n{text}"
    write_doc(filename, md, meta, {
        "type": "website",
        "source_url": url,
        "key": f"website:{url}",
    })
    return 1


def sync_custom_sheet(client: FeishuClient, url: str, sheet_name: str,
                      output: str, meta: dict, stype: str = "qa") -> int:
    """同步指定飞书表格"""
    print(f"\n📊 同步表格: {url} / {sheet_name}")

    # 从 URL 提取 spreadsheet_token
    match = re.search(r'/sheets/([A-Za-z0-9_]+)', url)
    if not match:
        print(f"  ❌ 无法从 URL 提取 spreadsheet_token: {url}")
        return 0
    spreadsheet_token = match.group(1)

    try:
        if stype == "qa":
            qa_pairs = extract_qa_from_sheet(client, spreadsheet_token, sheet_name)
            if qa_pairs:
                md = qa_to_markdown(qa_pairs, sheet_name)
                write_doc(output, md, meta, {
                    "type": "sheet-qa",
                    "source_url": url,
                    "sheet_name": sheet_name,
                    "key": f"custom:{spreadsheet_token}:{sheet_name}",
                })
                return 1
        elif stype == "table":
            rows = extract_table_from_sheet(client, spreadsheet_token, sheet_name)
            if rows:
                md = table_to_markdown(rows, sheet_name)
                write_doc(output, md, meta, {
                    "type": "sheet-table",
                    "source_url": url,
                    "sheet_name": sheet_name,
                    "key": f"custom:{spreadsheet_token}:{sheet_name}",
                })
                return 1
    except Exception as e:
        print(f"  ❌ 同步失败: {e}")
        import traceback
        traceback.print_exc()

    return 0


# ============================================================
# 主入口
# ============================================================

def main():
    global DATA_DIR

    parser = argparse.ArgumentParser(
        description="知识库数据同步工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 同步预设数据源（GZU Wellness 知识库问答）
  python sync_feishu.py --preset gzu-wellness-qa

  # 同步自定义表格
  python sync_feishu.py --sheet-url "https://xxx.feishu.cn/sheets/TOKEN" --sheet-name "Q&A" --output qa.md

  # 同步网站
  python sync_feishu.py --website "https://example.com" --website-title "网站名"

  # 使用配置文件
  python sync_feishu.py --config sources.json
        """,
    )
    # 预设
    parser.add_argument("--preset", help="预设数据源名称 (gzu-wellness-qa)")

    # 自定义表格
    parser.add_argument("--sheet-url", help="飞书电子表格 URL")
    parser.add_argument("--sheet-name", help="工作表名称")
    parser.add_argument("--sheet-type", choices=["qa", "table"], default="qa",
                        help="工作表类型: qa(问答) 或 table(表格)")
    parser.add_argument("--output", default="custom.md", help="输出文件名")

    # 网站
    parser.add_argument("--website", help="要抓取的网站 URL")
    parser.add_argument("--website-title", default="网站内容", help="网站标题")
    parser.add_argument("--website-output", default="website.md", help="网站输出文件名")

    # 配置文件
    parser.add_argument("--config", help="JSON 配置文件路径")

    # 通用
    parser.add_argument("--app-id", default=DEFAULT_APP_ID)
    parser.add_argument("--app-secret", default=DEFAULT_APP_SECRET)
    parser.add_argument("--force", action="store_true", help="强制重新同步")
    parser.add_argument("--data-dir", default=str(DATA_DIR), help="输出目录")

    args = parser.parse_args()

    DATA_DIR = Path(args.data_dir)
    client = FeishuClient(args.app_id, args.app_secret)
    meta = {} if args.force else load_meta()

    total = 0
    try:
        if args.preset:
            total += sync_preset(client, args.preset, meta)

        if args.sheet_url and args.sheet_name:
            total += sync_custom_sheet(
                client, args.sheet_url, args.sheet_name,
                args.output, meta, args.sheet_type,
            )

        if args.website:
            total += sync_website(
                args.website, args.website_title, args.website_output, meta,
            )

        if args.config:
            cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
            total += sync_all_sources(client, cfg.get("sources", []), meta)

        if total == 0 and not any([args.preset, args.sheet_url, args.website, args.config]):
            # 默认：同步所有预设数据源
            print("🔄 未指定来源，将同步所有预设数据源...")
            total += sync_all_sources(client, PRESET_SOURCES, meta)

        save_meta(meta)
        print(f"\n🎉 同步完成！共更新 {total} 个文档")
        print(f"📁 文档目录: {DATA_DIR.resolve()}")

    except Exception as e:
        print(f"\n❌ 同步失败: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
