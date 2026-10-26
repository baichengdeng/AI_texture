"""SQLite 存储：图库根目录 / 收藏 / 标签 / 画板 / 元数据缓存。"""
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS roots(path TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS favs(fid TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS tags(name TEXT NOT NULL, fid TEXT NOT NULL, UNIQUE(name, fid));
CREATE TABLE IF NOT EXISTS boards(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    items TEXT NOT NULL DEFAULT '[]',
    updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS meta_cache(
    fid TEXT PRIMARY KEY, mtime REAL, size INTEGER, meta TEXT
);
"""


class Store:
    def __init__(self, db_path: Path = None):
        DATA_DIR.mkdir(exist_ok=True)
        self._db = sqlite3.connect(
            str(db_path or DATA_DIR / "texture.db"), check_same_thread=False
        )
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(_SCHEMA)
            try:  # 旧库迁移：画板增加 edges 列（节点连线）
                self._db.execute("ALTER TABLE boards ADD COLUMN edges TEXT NOT NULL DEFAULT '[]'")
            except sqlite3.OperationalError:
                pass
            self._db.commit()

    # ---------- 根目录 ----------
    def roots(self) -> list:
        with self._lock:
            rows = self._db.execute("SELECT path FROM roots ORDER BY path").fetchall()
        return [r["path"] for r in rows]

    def add_root(self, path: str):
        p = Path(path).resolve()
        if not p.is_dir():
            raise ValueError(f"不是有效文件夹: {p}")
        # 拒绝与已有根目录互相嵌套（同图重复出现）
        for existing in self.roots():
            e = Path(existing)
            if p == e:
                return str(p)  # 已存在，幂等
            if e in p.parents or p in e.parents:
                raise ValueError(f"与已有根目录重叠：{existing}\n（请先移除其一再添加）")
        with self._lock:
            self._db.execute("INSERT OR IGNORE INTO roots(path) VALUES (?)", (str(p),))
            self._db.commit()
        return str(p)

    def remove_root(self, path: str):
        with self._lock:
            self._db.execute("DELETE FROM roots WHERE path = ?", (str(path),))
            self._db.commit()

    # ---------- 收藏 ----------
    def favs(self) -> set:
        with self._lock:
            rows = self._db.execute("SELECT fid FROM favs").fetchall()
        return {r["fid"] for r in rows}

    def set_fav(self, fid: str, value: bool):
        with self._lock:
            if value:
                self._db.execute("INSERT OR IGNORE INTO favs(fid) VALUES (?)", (fid,))
            else:
                self._db.execute("DELETE FROM favs WHERE fid = ?", (fid,))
            self._db.commit()

    # ---------- 标签 ----------
    def all_tags(self) -> dict:
        """{标签名: [fid, ...]}"""
        with self._lock:
            rows = self._db.execute("SELECT name, fid FROM tags").fetchall()
        result = {}
        for r in rows:
            result.setdefault(r["name"], []).append(r["fid"])
        return result

    def add_tags(self, fid: str, names: list):
        with self._lock:
            for n in names:
                n = n.strip()
                if n:
                    self._db.execute(
                        "INSERT OR IGNORE INTO tags(name, fid) VALUES (?, ?)", (n, fid)
                    )
            self._db.commit()

    def remove_tags(self, fid: str, names: list):
        with self._lock:
            for n in names:
                self._db.execute(
                    "DELETE FROM tags WHERE name = ? AND fid = ?", (n, fid)
                )
            self._db.commit()

    # ---------- 画板 ----------
    def boards(self) -> list:
        with self._lock:
            rows = self._db.execute(
                "SELECT id, name, updated FROM boards ORDER BY updated DESC"
            ).fetchall()
        return [{"id": r["id"], "name": r["name"], "updated": r["updated"]} for r in rows]

    @staticmethod
    def normalize_node(it: dict) -> dict:
        """统一节点模型，并兼容 v1 老数据。

        v1 的图片节点把「节点 id」和「图片指纹 fid」混用为一个字段 id；
        新模型拆成 id（节点身份）+ fileId（图片资源）。老数据不迁移数据库，
        读出来时就地补齐 fileId，节点 id 保持不变（仍然唯一，不影响连线）。
        """
        it.setdefault("type", "image")
        if it.get("type") != "comfy":
            # comfy 节点用 widgets 承载参数，不需要正文占位
            it.setdefault("text", "")
        if not str(it.get("id") or "").strip():
            it["id"] = "n" + uuid.uuid4().hex[:10]
        if it.get("type") == "comfy":
            # 节点图节点：标题与参数原样保留，坏数据也不至于让前端崩
            it["title"] = str(it.get("title") or it.get("cls") or "Node")
            it["cls"] = str(it.get("cls") or "")
            raw = it.get("widgets")
            clean = []
            if isinstance(raw, list):
                for w in raw:
                    if not isinstance(w, dict):
                        continue
                    v = w.get("v")
                    if v is None or str(v) == "":
                        continue
                    clean.append({"k": str(w.get("k") or ""), "v": str(v)})
            it["widgets"] = clean
            it["muted"] = bool(it.get("muted"))
        if it.get("type") == "image":
            if it.get("fileId") is not None:
                it["fileId"] = str(it.get("fileId") or "")
            elif it.get("file"):
                it["fileId"] = str(it["file"])
            else:
                # 老数据：id 就是图片指纹 fid
                it["fileId"] = str(it.get("id") or "")
            it.pop("file", None)
        # 数值兜底，坏数据也不至于让前端 NaN
        for k, dv in (("x", 0), ("y", 0), ("w", 240), ("h", 160)):
            try:
                it[k] = round(float(it.get(k, dv)))
            except (TypeError, ValueError):
                it[k] = dv
        return it

    @staticmethod
    def normalize_edge(e: dict) -> dict:
        f = e.get("from") or {}
        t = e.get("to") or {}
        sides = {"top", "right", "bottom", "left"}
        e["from"] = {
            "node": str(f.get("node", "")),
            "side": f.get("side") if f.get("side") in sides else "right",
        }
        e["to"] = {
            "node": str(t.get("node", "")),
            "side": t.get("side") if t.get("side") in sides else "left",
        }
        if not str(e.get("id") or "").strip():
            e["id"] = "e" + uuid.uuid4().hex[:10]
        return e

    def board(self, board_id: int) -> dict:
        with self._lock:
            r = self._db.execute(
                "SELECT id, name, items, edges FROM boards WHERE id = ?", (board_id,)
            ).fetchone()
        if not r:
            return None
        items = [self.normalize_node(it) for it in json.loads(r["items"]) if isinstance(it, dict)]
        edges = [self.normalize_edge(e) for e in json.loads(r["edges"] or "[]") if isinstance(e, dict)]
        # 丢弃端点已不存在的旧边（历史数据里的悬空边）
        alive = {it["id"] for it in items}
        edges = [e for e in edges if e["from"]["node"] in alive and e["to"]["node"] in alive]
        return {"id": r["id"], "name": r["name"], "items": items, "edges": edges}

    def create_board(self, name: str) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO boards(name, items, updated) VALUES (?, '[]', ?)",
                (name or "未命名画板", time.time()),
            )
            self._db.commit()
        return cur.lastrowid

    def save_board(self, board_id: int, name: str = None, items: list = None, edges: list = None):
        with self._lock:
            if name is not None:
                self._db.execute("UPDATE boards SET name = ? WHERE id = ?", (name, board_id))
            if items is not None:
                clean = [self.normalize_node(dict(it)) for it in items if isinstance(it, dict)]
                self._db.execute(
                    "UPDATE boards SET items = ?, updated = ? WHERE id = ?",
                    (json.dumps(clean, ensure_ascii=False), time.time(), board_id),
                )
            if edges is not None:
                clean_edges = [self.normalize_edge(dict(e)) for e in edges if isinstance(e, dict)]
                self._db.execute(
                    "UPDATE boards SET edges = ?, updated = ? WHERE id = ?",
                    (json.dumps(clean_edges, ensure_ascii=False), time.time(), board_id),
                )
            self._db.commit()

    def delete_board(self, board_id: int):
        with self._lock:
            self._db.execute("DELETE FROM boards WHERE id = ?", (board_id,))
            self._db.commit()

    # ---------- 元数据缓存 ----------
    def get_cached_meta(self, fid: str, mtime: float, size: int):
        with self._lock:
            r = self._db.execute(
                "SELECT meta FROM meta_cache WHERE fid = ? AND mtime = ? AND size = ?",
                (fid, mtime, size),
            ).fetchone()
        return json.loads(r["meta"]) if r else None

    def set_cached_meta(self, fid: str, mtime: float, size: int, meta: dict):
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO meta_cache(fid, mtime, size, meta) VALUES (?,?,?,?)",
                (fid, mtime, size, json.dumps(meta, ensure_ascii=False)),
            )
            self._db.commit()

    def cache_many(self, rows: list):
        """批量写缓存 rows=[(fid, mtime, size, meta_json)]，单事务提交。"""
        if not rows:
            return
        with self._lock:
            self._db.executemany(
                "INSERT OR REPLACE INTO meta_cache(fid, mtime, size, meta) VALUES (?,?,?,?)",
                rows,
            )
            self._db.commit()

    def cleanup_cache(self, keep_fids: set):
        """删除不再存在于图库的缓存行（孤儿回收）。"""
        with self._lock:
            rows = self._db.execute("SELECT fid FROM meta_cache").fetchall()
        stale = [r["fid"] for r in rows if r["fid"] not in keep_fids]
        for i in range(0, len(stale), 500):
            chunk = stale[i : i + 500]
            with self._lock:
                self._db.executemany(
                    "DELETE FROM meta_cache WHERE fid = ?", [(f,) for f in chunk]
                )
                self._db.commit()
