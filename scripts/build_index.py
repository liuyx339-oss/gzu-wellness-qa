#!/usr/bin/env python3
"""
文档索引构建脚本

读取 data/docs/ 下的 Markdown 文档，进行分块和向量化，
生成 chunks.json 和 embeddings.json 供前端 Worker 检索使用。

用法:
  python build_index.py
  python build_index.py --api-key sk-xxx --model text-embedding-3-small
  python build_index.py --embedding-provider anthropic  # 使用 Anthropic Embeddings

凭据优先级: 命令行参数 > 环境变量 > 默认值
  - OPENAI_API_KEY 或 ANTHROPIC_API_KEY
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

# ============================================================
# 配置
# ============================================================

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DOCS_DIR = DATA_DIR / "docs"
OUTPUT_CHUNKS = DATA_DIR / "chunks.json"
OUTPUT_EMBEDDINGS = DATA_DIR / "embeddings.json"

# 分块参数
CHUNK_MAX_TOKENS = 500   # 每个 chunk 最大 token 数
CHUNK_OVERLAP = 50       # 重叠 token 数

# 嵌入模型
EMBEDDING_MODELS = {
    "openai": "text-embedding-3-small",
    "anthropic": "voyage-3-lite",  # 需要 Anthropic API
}


# ============================================================
# 文档分块
# ============================================================

def estimate_tokens(text: str) -> int:
    """
    估算文本的 token 数。
    中文：约 1.5 字符/token；英文：约 4 字符/token。
    粗略估计：总字符数 / 2
    """
    return len(text) // 2


def split_by_headings(text: str) -> list[dict]:
    """
    按 Markdown 标题分割文档。
    返回 [{title, content, level}, ...]
    """
    sections = []
    # 匹配 Markdown 标题 (## ...)
    heading_pattern = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)

    matches = list(heading_pattern.finditer(text))
    if not matches:
        # 没有标题，整篇作为一个 section
        sections.append({"title": "", "content": text.strip(), "level": 0})
        return sections

    # 第一个标题之前的内容作为 preamble
    if matches[0].start() > 0:
        preamble = text[: matches[0].start()].strip()
        if preamble:
            sections.append({"title": "", "content": preamble, "level": 0})

    for i, match in enumerate(matches):
        level = len(match.group(1))
        title = match.group(2).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        content = text[start:end].strip()
        if content:
            sections.append({"title": title, "content": content, "level": level})

    return sections


def chunk_section(section: dict, doc_title: str, max_tokens: int, overlap: int) -> list[dict]:
    """
    将一个 section 的内容进一步按 token 限制分块。
    优先按段落边界切分。
    """
    text = section["content"]
    heading = section["title"]
    chunks = []

    # 按段落切分
    paragraphs = re.split(r"\n\s*\n", text)

    current_chunk = []
    current_tokens = 0

    def make_chunk(paras: list[str]) -> dict:
        content = "\n\n".join(paras)
        # 构建完整的 chunk 标题
        full_title = f"{doc_title} › {heading}" if heading else doc_title
        return {
            "title": full_title,
            "content": content,
            "tokens_est": estimate_tokens(content),
        }

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        para_tokens = estimate_tokens(para)

        if current_tokens + para_tokens > max_tokens and current_chunk:
            chunks.append(make_chunk(current_chunk))
            # 重叠：保留最后一个段落
            if len(current_chunk) > 1:
                current_chunk = current_chunk[-1:]
                current_tokens = estimate_tokens(current_chunk[0])
            else:
                current_chunk = []
                current_tokens = 0

        current_chunk.append(para)
        current_tokens += para_tokens

    if current_chunk:
        chunks.append(make_chunk(current_chunk))

    return chunks


def chunk_document(filepath: Path) -> list[dict]:
    """对单个 Markdown 文件进行分块"""
    text = filepath.read_text(encoding="utf-8")
    doc_title = filepath.stem  # 文件名作为文档标题

    # Step 1: 按标题分割
    sections = split_by_headings(text)

    # Step 2: 对每个 section 按 token 限制进一步分块
    all_chunks = []
    for section in sections:
        chunks = chunk_section(section, doc_title, CHUNK_MAX_TOKENS, CHUNK_OVERLAP)
        all_chunks.extend(chunks)

    return all_chunks


# ============================================================
# 向量化
# ============================================================

def generate_embeddings_openai(chunks: list[dict], api_key: str, model: str) -> list[list[float]]:
    """使用 OpenAI API 生成 embeddings"""
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    embeddings = []

    texts = [c["content"] for c in chunks]
    batch_size = 100  # OpenAI 批量限制

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        print(f"  📊 向量化 {i+1}-{min(i+batch_size, len(texts))}/{len(texts)} ...",
              end=" ", flush=True)

        resp = client.embeddings.create(model=model, input=batch)
        batch_embeddings = [d.embedding for d in resp.data]
        embeddings.extend(batch_embeddings)
        print("✅")

    return embeddings


def generate_embeddings_anthropic(chunks: list[dict], api_key: str, model: str) -> list[list[float]]:
    """使用 Anthropic API 生成 embeddings (Voyage)"""
    import requests

    embeddings = []
    texts = [c["content"] for c in chunks]
    batch_size = 128

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        print(f"  📊 向量化 {i+1}-{min(i+batch_size, len(texts))}/{len(texts)} ...",
              end=" ", flush=True)

        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": model,
                "input": batch,
            },
            timeout=60,
        )

        # Anthropic embeddings endpoint is different
        # Actually use Voyage AI API for Anthropic embeddings
        # Fall back to a direct embeddings API
        pass

    # Note: Anthropic doesn't have a direct embeddings API. Use Voyage AI instead.
    # For simplicity, we'll support OpenAI embeddings primarily.
    raise NotImplementedError(
        "Anthropic embeddings 需要 Voyage AI API。请使用 --embedding-provider openai"
    )


# ============================================================
# 主入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="文档索引构建工具")
    parser.add_argument("--api-key", help="AI API Key (OpenAI 或 Anthropic)")
    parser.add_argument(
        "--embedding-provider",
        choices=["openai", "anthropic"],
        default="openai",
        help="嵌入模型提供商",
    )
    parser.add_argument(
        "--embedding-model",
        help="嵌入模型名称（覆盖默认值）",
    )
    parser.add_argument("--docs-dir", default=str(DOCS_DIR), help="文档目录")
    parser.add_argument("--output-chunks", default=str(OUTPUT_CHUNKS), help="chunks 输出路径")
    parser.add_argument("--output-embeddings", default=str(OUTPUT_EMBEDDINGS), help="embeddings 输出路径")

    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("❌ 请提供 API Key: --api-key 或设置 OPENAI_API_KEY 环境变量", file=sys.stderr)
        sys.exit(1)

    embedding_model = args.embedding_model or EMBEDDING_MODELS.get(args.embedding_provider, "text-embedding-3-small")

    # --- Step 1: 收集文档 ---
    docs_dir = Path(args.docs_dir)
    if not docs_dir.exists():
        print(f"❌ 文档目录不存在: {docs_dir}", file=sys.stderr)
        sys.exit(1)

    md_files = sorted(docs_dir.glob("*.md"))
    if not md_files:
        print(f"❌ 文档目录中没有 .md 文件: {docs_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"📁 找到 {len(md_files)} 个 Markdown 文件")

    # --- Step 2: 分块 ---
    all_chunks = []
    for fp in md_files:
        chunks = chunk_document(fp)
        print(f"  📄 {fp.name}: {len(chunks)} chunks")
        all_chunks.extend(chunks)

    print(f"\n📦 总计 {len(all_chunks)} 个 chunks")

    # --- Step 3: 向量化 ---
    print(f"\n🔢 使用 {embedding_model} 生成向量...")
    if args.embedding_provider == "openai":
        embeddings = generate_embeddings_openai(all_chunks, api_key, embedding_model)
    else:
        embeddings = generate_embeddings_anthropic(all_chunks, api_key, embedding_model)

    # --- Step 4: 保存 ---
    # chunks.json: 文档元数据
    chunks_output = Path(args.output_chunks)
    chunks_output.parent.mkdir(parents=True, exist_ok=True)

    # 对每个 chunk 添加 id
    chunks_with_id = []
    for i, chunk in enumerate(all_chunks):
        chunks_with_id.append({
            "id": i,
            "title": chunk["title"],
            "content": chunk["content"],
            "tokens_est": chunk["tokens_est"],
        })

    chunks_output.write_text(
        json.dumps(chunks_with_id, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"✅ chunks → {chunks_output} ({len(chunks_with_id)} 条)")

    # embeddings.json: 向量数组
    embeddings_output = Path(args.output_embeddings)
    embeddings_output.write_text(
        json.dumps(embeddings, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"✅ embeddings → {embeddings_output} ({len(embeddings)} 个向量, "
          f"维度={len(embeddings[0]) if embeddings else 0})")

    # --- Step 5: 报告 ---
    total_chars = sum(len(c["content"]) for c in all_chunks)
    print(f"\n📊 统计:")
    print(f"   文档数: {len(md_files)}")
    print(f"   Chunks: {len(all_chunks)}")
    print(f"   总字符: {total_chars:,}")
    print(f"   平均 chunk 大小: {total_chars // len(all_chunks) if all_chunks else 0:,} 字符")
    print(f"   向量维度: {len(embeddings[0]) if embeddings else 'N/A'}")


if __name__ == "__main__":
    main()
