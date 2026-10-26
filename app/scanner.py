"""文件夹扫描：遍历图库根目录 → 条目列表（元数据走 SQLite 缓存）。

性能设计（对应 NFR-1）：
- fid = sha1(大小 + 前 64KB 内容)：改名/移动不丢收藏标签，内容相同视为同一张
- 扫描快路径 stealth=False 只读文本块，不整图解码
- 缓存只存轻量摘要（raw/workflow 大 JSON 剥离，详情页按需重读）
- 批量单事务写缓存；扫描结束回收孤儿缓存行
"""
import hashlib
import json
import time
from pathlib import Path

from .metadata import router

SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
# 列表/搜索用不到的大字段：不进缓存，详情页从文件重读
HEAVY_KEYS = ("raw", "prompt_json", "workflow_json")


def fid_for(path: Path) -> str:
    """内容指纹 id：文件大小 + 前 64KB 内容哈希。"""
    h = hashlib.sha1()
    with open(path, "rb") as f:
        h.update(f.read(65536))
    st = path.stat()
    h.update(str(st.st_size).encode())
    return h.hexdigest()[:16]


def _strip_heavy(meta: dict) -> dict:
    light = {k: v for k, v in meta.items() if k not in HEAVY_KEYS}
    light["_stripped"] = True
    return light


class Scanner:
    def __init__(self, store):
        self.store = store

    def scan(self, stealth: bool = False) -> list:
        """扫描全部根目录。stealth=False 跳过隐写全像素扫描（详情页再补）。"""
        items = []
        pending = []   # 批量缓存写入
        errors = 0
        t0 = time.time()
        for root in self.store.roots():
            root_path = Path(root)
            if not root_path.is_dir():
                continue
            for p in root_path.rglob("*"):
                if p.suffix.lower() not in SUPPORTED_EXTS or not p.is_file():
                    continue
                try:
                    st = p.stat()
                    fid = fid_for(p)
                except OSError:
                    errors += 1
                    continue
                mtime, size = st.st_mtime, st.st_size
                meta = self.store.get_cached_meta(fid, mtime, size)
                if meta is not None and "pxw" not in meta:
                    meta = None  # 旧缓存缺像素尺寸，重读一次升级
                if meta is None:
                    try:
                        meta = router.read_metadata(p, stealth=stealth)
                    except Exception as e:
                        errors += 1
                        meta = {"ok": False, "source": "error", "note": str(e)[:200]}
                    pending.append(
                        (fid, mtime, size, json.dumps(_strip_heavy(meta), ensure_ascii=False))
                    )
                items.append(
                    {
                        "id": fid,
                        "name": p.name,
                        "path": str(p),
                        "dir": str(p.parent),
                        "mtime": mtime,
                        "size": size,
                        "meta": meta,
                    }
                )
        if pending:
            self.store.cache_many(pending)
        self.store.cleanup_cache({it["id"] for it in items})
        items.sort(key=lambda x: x["mtime"], reverse=True)
        dt = time.time() - t0
        print(f"[scanner] {len(items)} 张 / {dt:.2f}s / 缓存新写 {len(pending)} / 失败 {errors}")
        return items
