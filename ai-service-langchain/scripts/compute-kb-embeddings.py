# -*- coding: utf-8 -*-
"""用本地 BGE 模型（512 维）为知识库补算 embedding，写回 Node 端 SQLite
用法：python scripts/compute-kb-embeddings.py
前置：ai-service-langchain/models/bge-small-zh-v1.5 已下载（离线可用）
"""
import os, sys, json, sqlite3

for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

DB_PATH = os.environ.get('SQLITE_DB_PATH', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server', 'data', 'service_init.db'))

def main():
    from knowledge.embedding import bge_embedding, _load_bge
    _load_bge()  # 显式加载（打印加载日志）
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("SELECT id, question, answer FROM knowledge").fetchall()
    print(f'待计算: {len(rows)} 条')
    n = 0
    for kid, q, a in rows:
        text = (q or '') + ' ' + (a or '')
        vec = bge_embedding(text)
        if not vec:
            print(f'  FAIL {kid} ({q})')
            continue
        conn.execute("UPDATE knowledge SET embedding = ? WHERE id = ?", (json.dumps(vec), kid))
        n += 1
    conn.commit()
    # 校验
    dims = conn.execute("SELECT DISTINCT length(embedding) FROM knowledge WHERE embedding IS NOT NULL").fetchall()
    conn.close()
    print(f'完成: {n}/{len(rows)} 条，embedding 维度分布: {dims}')

if __name__ == '__main__':
    main()
