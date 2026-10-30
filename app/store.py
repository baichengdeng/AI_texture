"""SQLite 存储：图库根目录 / 收藏 / 标签 / 画板 / 元数据缓存 / 偏好设置。"""
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from .settings import DATA_DIR

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
CREATE TABLE IF NOT EXISTS tag_docs(
    fid TEXT PRIMARY KEY, segs TEXT NOT NULL DEFAULT '[]', updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS seg_templates(
    name TEXT PRIMARY KEY, segs TEXT NOT NULL DEFAULT '[]', updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS private_fids(fid TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS private_dirs(path TEXT PRIMARY KEY);
"""

# 偏好设置默认值。新增键直接加在这里，老库不需要迁移。
# 注意「添加文件夹的方式」不在这里：它每次添加时在弹窗里现选（read / import），
# 不需要跨次记住，也就没有对应的偏好键。
SETTING_DEFAULTS = {
    "undo_limit": 50,          # 画板撤销/重做保留的步数
    "image_dir": "",           # 内置图片存储位置，空＝data/library
}

UNDO_MIN, UNDO_MAX = 5, 500

# TAG 分格：一格 = 一个主体名 + 一段自由文本。数量与长度都做上限，
# 避免 AI 或误操作写进超大 JSON 把库撑坏。
# 上限只做防护，不参与业务：空格子必须原样保留，否则前端「＋ 胶囊」
# 刚加上还没填内容的格子会在下一次自动保存时被清掉（表现为只能建一格）。
MAX_SEGS = 500
MAX_SEG_KEY = 40
MAX_SEG_BODY = 8000


def clean_segs(raw) -> list:
    """把任意输入洗成 [{k, v}]：k 是格子主体名，v 是这一格的内容。"""
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw[:MAX_SEGS]:
        if isinstance(item, str):
            k, v = "", item
        elif isinstance(item, dict):
            k = item.get("k", item.get("name", item.get("subject", "")))
            v = item.get("v", item.get("body", item.get("text", "")))
        else:
            continue
        k = str(k or "").strip()[:MAX_SEG_KEY]
        v = str(v or "")[:MAX_SEG_BODY]
        out.append({"k": k, "v": v})
    return out


class Store:
    def __init__(self, db_path: Path = None):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
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

    # ---------- 偏好设置 ----------
    def settings(self) -> dict:
        """读全部偏好，缺失的键用默认值补齐。"""
        with self._lock:
            rows = self._db.execute("SELECT k, v FROM settings").fetchall()
        out = dict(SETTING_DEFAULTS)
        for r in rows:
            if r["k"] not in out:
                continue
            try:
                out[r["k"]] = json.loads(r["v"])
            except ValueError:
                pass
        return out

    def set_settings(self, updates: dict) -> dict:
        """写入偏好（只接受已知键，值做范围校验）。返回写入后的完整设置。"""
        clean = {}
        for k, v in (updates or {}).items():
            if k == "undo_limit":
                try:
                    n = int(v)
                except (TypeError, ValueError):
                    raise ValueError("撤销步数需要是数字")
                clean[k] = max(UNDO_MIN, min(UNDO_MAX, n))
            elif k == "image_dir":
                clean[k] = str(v or "").strip()
        if clean:
            with self._lock:
                for k, v in clean.items():
                    self._db.execute(
                        "INSERT OR REPLACE INTO settings(k, v) VALUES (?,?)",
                        (k, json.dumps(v, ensure_ascii=False)),
                    )
                self._db.commit()
        return self.settings()

    def image_dir(self) -> Path:
        """内置图片存储位置：偏好值优先，空则用 data/library。"""
        raw = str(self.settings().get("image_dir") or "").strip()
        p = Path(raw).expanduser() if raw else DATA_DIR / "library"
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError:
            return DATA_DIR / "library"
        return p

    # ---------- 隐私标记 ----------
    def private_fids(self) -> set:
        with self._lock:
            rows = self._db.execute("SELECT fid FROM private_fids").fetchall()
        return {r["fid"] for r in rows}

    def private_dirs(self) -> list:
        with self._lock:
            rows = self._db.execute("SELECT path FROM private_dirs ORDER BY path").fetchall()
        return [r["path"] for r in rows]

    def set_private_fid(self, fid: str, value: bool):
        with self._lock:
            if value:
                self._db.execute("INSERT OR IGNORE INTO private_fids(fid) VALUES (?)", (fid,))
            else:
                self._db.execute("DELETE FROM private_fids WHERE fid = ?", (fid,))
            self._db.commit()

    def set_private_dir(self, path: str, value: bool):
        with self._lock:
            if value:
                self._db.execute("INSERT OR IGNORE INTO private_dirs(path) VALUES (?)", (path,))
            else:
                self._db.execute("DELETE FROM private_dirs WHERE path = ?", (path,))
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

    def delete_tag(self, name: str) -> int:
        """删除一个标签（所有图片上的该标签一并移除）。返回影响的行数。"""
        with self._lock:
            cur = self._db.execute("DELETE FROM tags WHERE name = ?", (name,))
            self._db.commit()
        return cur.rowcount

    def rename_tag(self, old: str, new: str) -> int:
        """重命名标签（所有图片同步改）。返回新名下的行数。"""
        with self._lock:
            self._db.execute(
                "UPDATE OR IGNORE tags SET name = ? WHERE name = ?", (new, old)
            )
            self._db.execute("DELETE FROM tags WHERE name = ?", (old,))  # 与新名重名的旧行清掉
            self._db.commit()
        return self._db.execute(
            "SELECT COUNT(*) FROM tags WHERE name = ?", (new,)
        ).fetchone()[0]

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

    # ---------- TAG 分格 ----------
    def tag_doc(self, fid: str) -> list:
        with self._lock:
            r = self._db.execute(
                "SELECT segs FROM tag_docs WHERE fid = ?", (fid,)
            ).fetchone()
        return clean_segs(json.loads(r["segs"])) if r else []

    def set_tag_doc(self, fid: str, segs) -> list:
        clean = clean_segs(segs)
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO tag_docs(fid, segs, updated) VALUES (?,?,?)",
                (fid, json.dumps(clean, ensure_ascii=False), time.time()),
            )
            self._db.commit()
        return clean

    def tag_docs(self, fids: list) -> dict:
        """批量读：{fid: [{k,v}, ...]}，没有内容的 fid 不出现在结果里。"""
        if not fids:
            return {}
        marks = ",".join("?" * len(fids))
        with self._lock:
            rows = self._db.execute(
                f"SELECT fid, segs FROM tag_docs WHERE fid IN ({marks})", list(fids)
            ).fetchall()
        out = {}
        for r in rows:
            segs = clean_segs(json.loads(r["segs"]))
            if segs:
                out[r["fid"]] = segs
        return out

    def all_tag_docs(self) -> dict:
        """{fid: 纯文本}，供搜索时一次性建索引，避免逐张查库。"""
        with self._lock:
            rows = self._db.execute("SELECT fid, segs FROM tag_docs").fetchall()
        out = {}
        for r in rows:
            segs = clean_segs(json.loads(r["segs"]))
            if segs:
                out[r["fid"]] = " ".join(
                    f"{s['k']} {s['v']}".strip() for s in segs
                )
        return out

    def copy_tag_docs(self, fids: list) -> list:
        """把一批图片的 TAG 分格并起来作为模板候选（按出现顺序去重主体名）。"""
        names = []
        for segs in self.tag_docs(fids).values():
            for s in segs:
                if s["k"] and s["k"] not in names:
                    names.append(s["k"])
        return names

    def templates(self) -> list:
        with self._lock:
            rows = self._db.execute(
                "SELECT name, segs, updated FROM seg_templates ORDER BY updated DESC"
            ).fetchall()
        return [
            {"name": r["name"], "segs": clean_segs(json.loads(r["segs"])),
             "updated": r["updated"]}
            for r in rows
        ]

    def save_template(self, name: str, segs) -> dict:
        name = str(name or "").strip()[:MAX_SEG_KEY]
        if not name:
            raise ValueError("模板名不能为空")
        # 模板 = 分格骨架：只记「有几格 + 每格叫什么」，
        # 格子里的内容不保存 —— 同一套分格在不同图片上要各写各的。
        # 连主体名都没写的空槽不进模板：套用时它也补不出什么名堂。
        clean = [{"k": s["k"], "v": ""} for s in clean_segs(segs) if s.get("k")]
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO seg_templates(name, segs, updated) VALUES (?,?,?)",
                (name, json.dumps(clean, ensure_ascii=False), time.time()),
            )
            self._db.commit()
        return {"name": name, "segs": clean}

    def delete_template(self, name: str):
        with self._lock:
            self._db.execute("DELETE FROM seg_templates WHERE name = ?", (name,))
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
        # 固定（锁定位置与大小）：只留 True，其余一律清掉，避免脏数据
        if it.get("pin"):
            it["pin"] = True
        else:
            it.pop("pin", None)
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
        # 走线方式：贝塞尔曲线 / 90° 直角 / 45° 折角 / 直线
        if e.get("route") not in {"curve", "ortho", "diag", "line"}:
            e.pop("route", None)
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
