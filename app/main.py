"""Texture 主服务：FastAPI 路由 + 静态 Web UI。

启动：python run.py  （默认 http://127.0.0.1:8770）
"""
import json
import os
import re
import shutil
import time
import unicodedata
import urllib.parse
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .comfy_graph import graph_to_board, read_graph_for_file
from .export import board_to_canvas, board_to_html, to_a1111_text
from .metadata import router as meta_router
from .scanner import SUPPORTED_EXTS, Scanner, fid_for
from .settings import DATA_DIR, migrate_data
from .store import UNDO_MAX, UNDO_MIN, Store, clean_segs
from .thumbnails import THUMB_DIR, get_thumbnail
from .winrecycle import delete_to_recyclebin

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="Texture", description="AI 图片元数据管理")
store = Store()
scanner = Scanner(store)

# 内存缓存最近一次扫描结果（几千张规模足够）
_items_by_id: dict = {}
_items_list: list = []

# ---------------- 隐私模式 ----------------
# 开关只在本次运行有效：重启后恒为关闭，避免「上次开着，这次悄悄全露出来」。
_privacy_on = False
_private_fids: set = set()
_private_dirs: list = []


def _norm_path(p) -> str:
    try:
        return os.path.normcase(os.path.normpath(str(p)))
    except (TypeError, ValueError):
        return str(p)


def _reload_privacy() -> None:
    global _private_fids, _private_dirs
    _private_fids = store.private_fids()
    _private_dirs = [_norm_path(p) for p in store.private_dirs()]


def set_privacy(on: bool) -> None:
    global _privacy_on
    _privacy_on = bool(on)


def privacy_on() -> bool:
    return _privacy_on


def _hidden(it: dict) -> bool:
    """这条记录在当前模式下该不该藏起来。隐私模式开着就一律不藏。"""
    if _privacy_on:
        return False
    if it.get("id") in _private_fids:
        return True
    d = _norm_path(it.get("dir") or "")
    for pd in _private_dirs:
        if d == pd or d.startswith(pd + os.sep):
            return True
    return False


def _visible(items: list) -> list:
    return [it for it in items if not _hidden(it)]


# ---------------- 搜索语法 ----------------
# 空格（或逗号）分隔＝同时包含；/正则/flags 走正则。写成纯函数，便于单测。
#
# 拆词不能直接 re.split：正则里常有空格（/Save Image/），先按斜杠划出整段更省事。

_REGEX_TOKEN = re.compile(r"^/(.+)/([imsx]*)$", re.S)
_REGEX_FLAGS = {"i": re.I, "m": re.M, "s": re.S, "x": re.X}
_SEPARATORS = " \t\r\n,，、\u3000"


def split_query(text: str) -> list:
    """把查询串拆成词，但 /…/ 里的内容整体算一个词。

    词首的斜杠进入正则模式，跳到配对的斜杠（`\\/` 视为转义）为止；
    找不到收尾斜杠就当作普通文字，交给后面降级。
    """
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "/" and not buf:
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "/":
                    break
                j += 1
            if j < n:                       # 有收尾斜杠
                buf.append(text[i:j + 1])
                i = j + 1
                continue
        if ch in _SEPARATORS:
            if buf:
                out.append("".join(buf))
                buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    if buf:
        out.append("".join(buf))
    return out


def parse_search(q: str) -> tuple:
    """查询串 → (matchers, error)。

    matchers 是 [("sub", 小写词)] 或 [("re", 编译好的正则)]，全部按 AND 叠加。
    正则写错时不报错、降级成字面量，同时把错误原文回传给前端提示。
    """
    text = unicodedata.normalize("NFKC", q or "").strip()
    if not text:
        return [], ""
    out, error = [], ""
    for token in split_query(text):
        if not token:
            continue
        m = _REGEX_TOKEN.match(token)
        if not m:
            out.append(("sub", token.lower()))
            continue
        body, flags = m.group(1), m.group(2).lower()
        extra = 0
        for ch in flags:
            extra |= _REGEX_FLAGS.get(ch, 0)
        try:
            out.append(("re", re.compile(body, re.I | extra)))
        except re.error as e:
            error = f"{body} —— {e}"
            out.append(("sub", token.lower()))
    return out, error


def search_hit(matchers: list, hay: str, hay_low: str) -> bool:
    for kind, pat in matchers:
        if kind == "sub":
            if pat not in hay_low:
                return False
        elif not pat.search(hay):
            return False
    return True


_reload_privacy()


def _refresh(stealth: bool = False):
    global _items_by_id, _items_list
    _items_list = scanner.scan(stealth=stealth)
    _items_by_id = {it["id"]: it for it in _items_list}


def _item(fid: str) -> dict:
    if fid not in _items_by_id:
        _refresh()
    it = _items_by_id.get(fid)
    if not it or _hidden(it):
        raise HTTPException(404, "图片不在图库中（可能已删除，或处于隐私文件夹里）")
    return it


def _hidden_fid(fid: str) -> bool:
    """按图片指纹判断是否被隐私藏起来（画板节点、导出这类只知道 fid 的场合用）。"""
    if _privacy_on or not fid:
        return False
    it = _items_by_id.get(fid)
    if it is None and fid not in _items_by_id:
        if not _items_list:
            _refresh()
        it = _items_by_id.get(fid)
    return _hidden({"id": fid, "dir": (it or {}).get("dir") or ""})


def _mask_hidden_nodes(board: dict) -> dict:
    """隐私模式关闭时，把指向隐私图片的画板节点标成 hidden 并抹掉路径。

    只标不影响保存：前端按 hidden 画占位，把节点原样留在画板上，
    下次打开隐私模式内容自己回来。路径一并去掉，避免占位里露出文件名。
    """
    if _privacy_on:
        return board
    for it in board.get("items", []):
        if it.get("type") not in ("image", "file"):
            continue
        fid = str(it.get("fileId") or it.get("id") or "")
        if not _hidden_fid(fid):
            continue
        it["hidden"] = True
        it.pop("path", None)
        it.pop("src", None)
    return board


def _full_meta(it: dict) -> dict:
    """详情/导出用：缓存里被剥离的大 JSON(raw/workflow)从文件重读。"""
    meta = it["meta"]
    if meta.get("_stripped") or meta.get("source") in ("none", "error"):
        try:
            meta = meta_router.read_metadata(it["path"], stealth=True)
        except Exception as e:
            meta = dict(meta)
            meta["note"] = str(e)[:200]
        it["meta"] = meta
    return meta


def _family(source: str) -> str:
    """来源统一归入三类：ComfyUI / WebUI / 无数据。

    NovelAI、A1111、InvokeAI 等浏览器式 WebUI 都归为 webui；
    ComfyUI 保持独立；无元数据与解析错误合并为 none。
    """
    if source == "comfyui":
        return "comfyui"
    if source in ("none", "error", ""):
        return "none"
    return "webui"


def _summary(it: dict, favs: set, tag_map: dict) -> dict:
    meta = it["meta"]
    source = meta.get("source", "none")
    return {
        "id": it["id"],
        "name": it["name"],
        "path": it["path"],
        "dir": it["dir"],
        "mtime": it["mtime"],
        "size": it["size"],
        "w": meta.get("pxw", 0),
        "h": meta.get("pxh", 0),
        "source": source,
        "family": _family(source),
        "tool": meta.get("tool", ""),
        "prompt": (meta.get("prompt") or "")[:160],
        "model": meta.get("params", {}).get("model", ""),
        "sampler": meta.get("params", {}).get("sampler", ""),
        "seed": meta.get("params", {}).get("seed", ""),
        "fav": it["id"] in favs,
        "tags": sorted(t for t, ids in tag_map.items() if it["id"] in ids),
    }


# ---------------- 图库 ----------------

class RootIn(BaseModel):
    path: str


@app.get("/api/roots")
def api_roots():
    keep = []
    for r in store.roots():
        nr = _norm_path(r)
        if not _privacy_on and any(
                nr == pd or nr.startswith(pd + os.sep) or pd.startswith(nr + os.sep)
                for pd in _private_dirs):
            continue
        keep.append(r)
    return {"roots": keep}


@app.post("/api/roots")
def api_add_root(body: RootIn):
    try:
        p = store.add_root(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    _refresh()
    return {"roots": store.roots(), "added": p}


@app.delete("/api/roots")
def api_del_root(path: str):
    store.remove_root(path)
    _refresh()
    return {"roots": store.roots()}


def _under_dir(it: dict, dir_path: str, subfolders: bool = True) -> bool:
    if not dir_path:
        return True
    try:
        p = Path(it["path"])
        d = Path(dir_path)
        if subfolders:
            return p.is_relative_to(d)
        return _cpath(p.parent) == _cpath(d)
    except (OSError, ValueError):
        return False


@app.get("/api/images")
def api_images(
    q: str = "",
    source: str = "",
    family: str = "",
    model: str = "",
    sampler: str = "",
    ratio: str = "",
    tag: str = "",
    tags: str = "",
    fav: bool = False,
    root: str = "",
    dir: str = "",
    subfolders: bool = True,
    sort: str = "time-desc",
):
    if not _items_list:
        _refresh()
    import unicodedata

    visible = _visible(_items_list)
    favs = store.favs()
    tag_map = store.all_tags()
    items = []
    # 多关键词 AND：空格（或逗号）分隔，每个词都须命中；/正则/flags 走正则
    matchers, regex_error = parse_search(q)
    # 搜索范围：文件名 + 正负提示词 + 标签 + TAG 分格内容
    rev_tags: dict = {}
    if matchers:
        for name, ids in tag_map.items():
            for fid in ids:
                rev_tags.setdefault(fid, []).append(name)
        tag_docs = store.all_tag_docs()
    else:
        tag_docs = {}
    # 提示词胶囊多选：每个标签都须命中（AND），与侧栏单选标签叠加
    want_tags = [t.strip() for t in tags.replace("，", ",").split(",") if t.strip()]
    if tag and tag not in want_tags:
        want_tags.append(tag)
    for it in visible:
        if matchers:
            hay = unicodedata.normalize(
                "NFKC",
                " ".join((
                    it["name"],
                    it["meta"].get("prompt") or "",
                    it["meta"].get("negative") or "",
                    " ".join(rev_tags.get(it["id"], ())),
                    tag_docs.get(it["id"], ""),
                )),
            )
            if not search_hit(matchers, hay, hay.lower()):
                continue
        item_source = it["meta"].get("source", "none")
        if source and item_source != source:
            continue
        if family and _family(item_source) != family:
            continue
        if model and it["meta"].get("params", {}).get("model", "") != model:
            continue
        if sampler and it["meta"].get("params", {}).get("sampler", "") != sampler:
            continue
        if ratio:  # 宽高比过滤：横版/竖版/方形（5% 容差）
            w, h = it["meta"].get("pxw", 0), it["meta"].get("pxh", 0)
            if w and h:
                kind = "landscape" if w > h * 1.05 else ("portrait" if h > w * 1.05 else "square")
                if kind != ratio:
                    continue
        if want_tags and not all(it["id"] in tag_map.get(t, ()) for t in want_tags):
            continue
        if fav and it["id"] not in favs:
            continue
        if root and not Path(it["path"]).is_relative_to(Path(root)):
            continue
        if not _under_dir(it, dir, subfolders):
            continue
        items.append(_summary(it, favs, tag_map))
    # 过滤选项
    models = sorted({m for it in visible if (m := it["meta"].get("params", {}).get("model"))})
    samplers = sorted({s for it in visible if (s := it["meta"].get("params", {}).get("sampler"))})
    # 排序：time/name/size/type + asc/desc
    sort_key, _, sort_dir = sort.partition("-")
    keymap = {
        "time": lambda x: x["mtime"],
        "name": lambda x: x["name"].lower(),
        "size": lambda x: x["size"],
        "type": lambda x: Path(x["name"]).suffix.lower(),
    }
    if sort_key in keymap:
        items.sort(key=keymap[sort_key], reverse=sort_dir != "asc")
    return {"total": len(items), "items": items, "models": models,
            "samplers": samplers, "regexError": regex_error}


@app.get("/api/facets")
def api_facets(dir: str = "", subfolders: bool = True):
    """LIBRARY 分类计数：随当前文件夹变化，不受来源/标签/收藏过滤影响。"""
    if not _items_list:
        _refresh()
    favs = store.favs()
    counts = {"total": 0, "fav": 0, "comfyui": 0, "webui": 0, "none": 0}
    for it in _visible(_items_list):
        if not _under_dir(it, dir, subfolders):
            continue
        counts["total"] += 1
        if it["id"] in favs:
            counts["fav"] += 1
        counts[_family(it["meta"].get("source", "none"))] += 1
    return counts



def _folder_tree(items: list) -> list:
    """按根目录聚合目录树：{path,name,count(直属),total(含子目录),children}。"""
    roots = store.roots()
    if not roots:
        roots = sorted({Path(it["path"]).anchor or it["dir"] for it in items})
    nodes, tops = {}, []
    key = lambda p: os.path.normcase(os.path.normpath(str(p)))
    for r in roots:
        node = {"path": r, "name": Path(r).name or r, "count": 0, "total": 0, "children": []}
        nodes[key(r)] = node
        tops.append(node)

    for it in items:
        d = it["dir"]
        owner = next((r for r in roots if Path(it["path"]).is_relative_to(Path(r))), None)
        if owner is None:
            node = nodes.get(key(d))
            if node is None:
                node = {"path": d, "name": Path(d).name or d, "count": 0, "total": 0,
                        "children": []}
                nodes[key(d)] = node
                tops.append(node)
            node["count"] += 1
            continue
        cur = nodes[key(owner)]
        cur_path = Path(owner)
        try:
            rel = Path(d).relative_to(cur_path)
        except ValueError:
            rel = Path(".")
        for part in rel.parts:
            if part in (".", ""):
                continue
            cur_path = cur_path / part
            child = nodes.get(key(cur_path))
            if child is None:
                child = {"path": str(cur_path), "name": part, "count": 0, "total": 0,
                         "children": []}
                nodes[key(cur_path)] = child
                cur["children"].append(child)
            cur = child
        cur["count"] += 1

    def finish(node):
        node["children"].sort(key=lambda c: c["name"].lower())
        node["total"] = node["count"] + sum(finish(c) for c in node["children"])
        return node["total"]

    for t in tops:
        finish(t)
    tops.sort(key=lambda n: n["name"].lower())
    return tops


@app.get("/api/folders")
def api_folders():
    """侧栏文件夹树（一次返回，容量几千张时足够轻）。"""
    if not _items_list:
        _refresh()
    visible = _visible(_items_list)
    return {"roots": _folder_tree(visible), "total": len(visible)}


@app.post("/api/rescan")
def api_rescan():
    _refresh()
    return {"total": len(_items_list)}


# ---------------- 偏好设置 / 存储位置 ----------------

def _privacy_payload() -> dict:
    if _private_fids and not _items_list:
        _refresh()
    items = []
    for fid in sorted(_private_fids):
        it = _items_by_id.get(fid)
        items.append({
            "id": fid,
            "name": it["name"] if it else fid,
            "dir": it["dir"] if it else "",
        })
    return {
        "on": _privacy_on,
        "items": items,
        "dirs": store.private_dirs(),
        "count": len(_private_fids) + len(_private_dirs),
    }


def _settings_payload() -> dict:
    s = store.settings()
    return {
        "undo_limit": s["undo_limit"],
        "image_dir": str(store.image_dir()),
        "data_dir": str(DATA_DIR),
        "default_image_dir": str(DATA_DIR / "library"),
        "undo_min": UNDO_MIN,
        "undo_max": UNDO_MAX,
        "privacy": _privacy_payload(),
    }


class SettingsIn(BaseModel):
    undo_limit: int = None
    image_dir: str = None


@app.get("/api/settings")
def api_settings():
    return _settings_payload()


@app.post("/api/settings")
def api_save_settings(body: SettingsIn):
    updates = {}
    if body.undo_limit is not None:
        updates["undo_limit"] = body.undo_limit
    if body.image_dir is not None:
        raw = str(body.image_dir).strip()
        if not raw:
            updates["image_dir"] = ""
        else:
            p = Path(raw).expanduser()
            if not p.is_absolute():
                raise HTTPException(400, "请填写绝对路径，例如 D:\\TextureImages")
            try:
                p.mkdir(parents=True, exist_ok=True)
                probe = p / ".texture-write-test"
                probe.write_text("ok", encoding="utf-8")
                probe.unlink(missing_ok=True)
            except OSError as e:
                raise HTTPException(400, f"这个目录不可写：{e}")
            updates["image_dir"] = str(p.resolve())
    try:
        store.set_settings(updates)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _settings_payload()


class StorageIn(BaseModel):
    data_dir: str


@app.post("/api/settings/storage")
def api_storage(body: StorageIn):
    """把数据库与缩略图迁到新位置；写入指针后需要重启才生效。"""
    raw = str(body.data_dir or "").strip()
    if not raw:
        raise HTTPException(400, "请填写数据目录")
    target = Path(raw).expanduser()
    if not target.is_absolute():
        raise HTTPException(400, "请填写绝对路径，例如 D:\\TextureData")
    try:
        info = migrate_data(target)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "restart": True, "data_dir": str(target.resolve()), **info}


# ---------------- 隐私模式 ----------------

class PrivacyModeIn(BaseModel):
    on: bool = False


class PrivacyMarkIn(BaseModel):
    fid: str = ""
    path: str = ""
    private: bool = True


@app.get("/api/privacy")
def api_privacy():
    return _privacy_payload()


@app.post("/api/privacy/mode")
def api_privacy_mode(body: PrivacyModeIn):
    set_privacy(body.on)
    return _privacy_payload()


@app.post("/api/privacy/mark")
def api_privacy_mark(body: PrivacyMarkIn):
    if body.fid:
        store.set_private_fid(body.fid, body.private)
    elif body.path:
        p = Path(body.path).expanduser()
        try:
            p = p.resolve()
        except OSError:
            raise HTTPException(400, "路径不合法")
        if not p.is_dir():
            raise HTTPException(400, "不是有效文件夹")
        store.set_private_dir(str(p), body.private)
    else:
        raise HTTPException(400, "缺少 fid 或 path")
    _reload_privacy()
    return _privacy_payload()


# ---------------- 添加文件夹（导入 / 只读） ----------------

class ImportRootIn(BaseModel):
    path: str


def _import_root(src: Path) -> dict:
    """把一个文件夹里的图片复制到内置位置，校验后再把原件移入回收站。"""
    if not src.is_dir():
        raise ValueError(f"不是有效文件夹：{src}")
    dest = store.image_dir() / f"{src.name or 'import'}_{time.strftime('%Y%m%d_%H%M%S')}"
    copied, failed = [], []
    for p in src.rglob("*"):
        if p.suffix.lower() not in SUPPORTED_EXTS or not p.is_file():
            continue
        out = dest / p.relative_to(src)
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, out)
            copied.append((p, out))
        except OSError:
            failed.append(str(p))
    removed = 0
    for orig, new in copied:
        try:
            if new.stat().st_size != orig.stat().st_size:
                continue
        except OSError:
            continue
        ok, _bad = delete_to_recyclebin([str(orig)])
        removed += ok
    added = ""
    if copied:
        try:
            added = store.add_root(str(dest))
        except ValueError:
            added = str(dest)   # 与已有根目录重叠时也能用，只是不重复登记
    return {
        "source": str(src),
        "dest": str(dest),
        "root": added,
        "copied": len(copied),
        "removed": removed,
        "failed": len(failed),
    }


@app.post("/api/roots/import")
def api_import_root(body: ImportRootIn):
    """把源文件夹里的图片复制到内置位置，校验后再把原件移入回收站。"""
    try:
        info = _import_root(Path(str(body.path or "").strip()).expanduser())
    except ValueError as e:
        raise HTTPException(400, str(e))
    _refresh()
    return {"ok": True, **info}


class BatchRootIn(BaseModel):
    paths: list = None
    mode: str = "read"      # read＝只读取；import＝复制到内置位置后清空原文


@app.post("/api/roots/batch")
def api_batch_roots(body: BatchRootIn):
    """批量登记文件夹。逐个处理，单个失败不影响其余，最后汇总。"""
    raw = [str(p or "").strip() for p in (body.paths or [])]
    paths = list(dict.fromkeys(p for p in raw if p))     # 去空、去重、保序
    if not paths:
        raise HTTPException(400, "没有可添加的文件夹")
    mode = body.mode if body.mode in ("read", "import") else "read"
    done, skipped = [], []
    for p in paths:
        try:
            src = Path(p).expanduser()
            if not src.is_dir():
                skipped.append({"path": p, "reason": "不是有效文件夹"})
                continue
            if mode == "import":
                info = _import_root(src)
                done.append({"path": info["dest"], "source": info["source"],
                             "mode": "import", "copied": info["copied"],
                             "removed": info["removed"], "failed": info["failed"]})
            else:
                done.append({"path": store.add_root(str(src)), "mode": "read"})
        except (ValueError, OSError) as e:
            skipped.append({"path": p, "reason": str(e)[:120]})
    _refresh()
    return {"ok": True, "added": done, "skipped": skipped,
            "mode": mode, "roots": store.roots()}



@app.get("/api/file/{fid}")
def api_file(fid: str):
    it = _item(fid)
    return FileResponse(it["path"])


@app.get("/api/thumb/{fid}")
def api_thumb(fid: str, s: int = 512):
    it = _item(fid)
    try:
        tp = get_thumbnail(Path(it["path"]), fid, s)
    except Exception as e:
        raise HTTPException(500, f"缩略图生成失败: {e}")
    return FileResponse(tp, headers={"Cache-Control": "max-age=86400"})


@app.get("/api/meta/{fid}")
def api_meta(fid: str):
    """详情页元数据：被剥离的大 JSON 或隐写图从文件重读（stealth 全量检测）。"""
    it = _item(fid)
    meta = dict(_full_meta(it))
    meta.pop("_stripped", None)
    meta["fav"] = fid in store.favs()
    meta["tags"] = sorted(t for t, ids in store.all_tags().items() if fid in ids)
    meta["file"] = {"name": it["name"], "path": it["path"], "size": it["size"], "mtime": it["mtime"]}
    meta["tagdoc"] = store.tag_doc(fid)
    return meta


# ---------------- 文件操作（管理软件必备） ----------------

class DeleteIn(BaseModel):
    ids: list


@app.post("/api/delete_files")
def api_delete_files(body: DeleteIn):
    """把图片移入系统回收站（可恢复）。只允许删除图库内已扫描的文件。"""
    paths, fids = [], []
    for fid in body.ids:
        it = _items_by_id.get(fid) or (fid in _items_by_id and _items_by_id[fid])
        if not it:
            _refresh()
            it = _items_by_id.get(fid)
        if it and Path(it["path"]).is_file():
            paths.append(it["path"])
            fids.append(fid)
    if not paths:
        raise HTTPException(404, "没有可删除的文件")
    ok, fail = delete_to_recyclebin(paths)
    _refresh()   # 重扫后扫描器会自动清掉这些文件的缓存行
    return {"deleted": ok, "failed": fail}


@app.get("/api/reveal/{fid}")
def api_reveal(fid: str):
    """在资源管理器中定位该文件。"""
    it = _item(fid)
    import subprocess
    subprocess.Popen(["explorer", "/select,", it["path"]])
    return {"ok": True}


# ---------------- 收藏 / 标签 ----------------

class FavIn(BaseModel):
    id: str
    value: bool


class TagsIn(BaseModel):
    id: str
    add: list = []
    remove: list = []


@app.post("/api/fav")
def api_fav(body: FavIn):
    store.set_fav(body.id, body.value)
    return {"ok": True}


@app.post("/api/tags")
def api_tags(body: TagsIn):
    store.add_tags(body.id, body.add)
    store.remove_tags(body.id, body.remove)
    return {"ok": True}


@app.get("/api/tags")
def api_all_tags():
    return {"tags": {k: len(v) for k, v in sorted(store.all_tags().items())}}


class TagRenameIn(BaseModel):
    old: str
    new: str


@app.delete("/api/tags")
def api_delete_tag(name: str):
    """删除一个标签（所有图片同步移除）。"""
    n = store.delete_tag(name)
    return {"ok": True, "removed": n}


@app.post("/api/tags/rename")
def api_rename_tag(body: TagRenameIn):
    old, new = body.old.strip(), body.new.strip()
    if not old or not new:
        raise HTTPException(400, "标签名不能为空")
    n = store.rename_tag(old, new)
    return {"ok": True, "count": n}


# ---------------- 重命名 ----------------

class RenameIn(BaseModel):
    name: str
    path: str = ""   # 精确指定改哪一份：同一内容可能在多个根目录各有一份


def _item_at(fid: str, path: str = "") -> dict:
    """优先按路径定位条目。

    fid 是内容指纹，两个目录里的同一张图会共用一个 fid；
    涉及到改文件名的操作必须按路径精确命中，否则可能改错那一份。
    """
    if path:
        want = _cpath(path)
        if not _items_list:
            _refresh()
        for it in _items_list:
            if it["id"] == fid and _cpath(it["path"]) == want:
                return it
    return _item(fid)


@app.post("/api/rename/{fid}")
def api_rename(fid: str, body: RenameIn):
    """就地重命名文件（只改文件名，不移动目录）。

    fid 是「文件大小 + 前 64KB 内容」的哈希，改名不会变，
    所以收藏、标签、画板里对这张图的引用都保持有效。
    """
    import re

    it = _item_at(fid, body.path)
    src = Path(it["path"])
    if not src.is_file():
        raise HTTPException(404, "文件不存在（可能已被移动或删除）")
    raw = (body.name or "").strip()
    if not raw:
        raise HTTPException(400, "文件名不能为空")
    raw = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", raw).strip(" .")
    if not raw:
        raise HTTPException(400, "文件名不合法")
    if not raw.lower().endswith(src.suffix.lower()):
        raw += src.suffix
    dest = src.with_name(raw)
    if dest == src:
        return {"ok": True, "name": src.name, "id": fid}
    if dest.exists():
        raise HTTPException(409, "同目录下已有同名文件")
    try:
        src.rename(dest)
    except OSError as e:
        raise HTTPException(400, f"重命名失败：{e}")
    _refresh()
    return {"ok": True, "name": dest.name, "id": fid_for(dest)}


# ---------------- TAG 分格（可供 AI 直接接入的读写接口） ----------------
# 一格 = 一个主体名 k + 一段自由文本 v。模板只存主体名骨架，方便套用。


def merge_segs(cur: list, base: list) -> list:
    """把骨架 base 套到已有的 cur 上。

    按分格名对齐：同名的一格保留 cur 的内容（模板不带内容，不该覆盖），
    骨架里多出来的名字补一格空壳；cur 里多出来的格子原样保留。
    """
    out = [dict(s) for s in cur]
    have = {s["k"] for s in out if s["k"]}
    for s in base:
        k = s.get("k") or ""
        if not k:
            continue
        if k in have:
            continue
        have.add(k)
        out.append({"k": k, "v": ""})
    return out


class SegIn(BaseModel):
    k: str = ""
    v: str = ""


class TagDocIn(BaseModel):
    segs: list = []


class TagDocBatchIn(BaseModel):
    ids: list = []


class TplIn(BaseModel):
    name: str
    segs: list = []


class TagApplyIn(BaseModel):
    ids: list = []
    template: str = ""
    segs: list = []
    mode: str = "merge"     # merge：只补缺失的格子；replace：整份替换


@app.get("/api/tagdoc/templates")
def api_tag_templates():
    return {"templates": store.templates()}


@app.post("/api/tagdoc/templates")
def api_tag_template_save(body: TplIn):
    try:
        return {"template": store.save_template(body.name, body.segs)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/tagdoc/templates")
def api_tag_template_del(name: str):
    store.delete_template(name)
    return {"ok": True}


@app.post("/api/tagdoc/batch")
def api_tagdoc_batch(body: TagDocBatchIn):
    """批量读：{"ids": [...]} → {"docs": {fid: [{k, v}]}}"""
    fids = [str(x) for x in body.ids if x]
    return {"docs": store.tag_docs(fids)}


@app.post("/api/tagdoc/apply")
def api_tagdoc_apply(body: TagApplyIn):
    """把一份分格骨架（模板）套用到多张图片。

    模板只有「有几格 + 每格叫什么」，没有内容，所以套用时：
    - merge：目标图已有的格子连同内容原样保留，只补上缺的格子（内容留空）；
    - replace：整份换成骨架，内容清空。
    """
    fids = [str(x) for x in body.ids if x]
    if not fids:
        raise HTTPException(400, "没有指定图片")
    if body.template:
        found = next((t for t in store.templates() if t["name"] == body.template), None)
        if not found:
            raise HTTPException(404, f"模板不存在：{body.template}")
        base = found["segs"]
    else:
        base = clean_segs(body.segs)
    if not base:
        raise HTTPException(400, "分格为空")
    saved = {}
    for fid in fids:
        if body.mode == "replace":
            segs = [{"k": s["k"], "v": ""} for s in base]
        else:
            segs = merge_segs(store.tag_doc(fid), base)
        saved[fid] = store.set_tag_doc(fid, segs)
    return {"ok": True, "docs": saved}


@app.get("/api/tagdoc/{fid}")
def api_tagdoc_get(fid: str):
    return {"id": fid, "segs": store.tag_doc(fid)}


@app.put("/api/tagdoc/{fid}")
@app.post("/api/tagdoc/{fid}")
def api_tagdoc_set(fid: str, body: TagDocIn):
    """整份写入某张图片的 TAG 分格（PUT / POST 等价，方便 AI 调用）。"""
    return {"id": fid, "segs": store.set_tag_doc(fid, body.segs)}


# ---------------- 导出 ----------------

@app.get("/api/export/a1111/{fid}")
def api_export_a1111(fid: str, download: bool = False):
    it = _item(fid)
    text = to_a1111_text(_full_meta(it))
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{fid}_parameters.txt"'
    return PlainTextResponse(text, headers=headers)


@app.get("/api/export/comfy/{fid}")
def api_export_comfy(fid: str):
    it = _item(fid)
    meta = _full_meta(it)
    payload = meta.get("workflow_json") or meta.get("prompt_json")
    if not payload:
        raise HTTPException(404, "该图片没有 ComfyUI workflow JSON（可能不是 ComfyUI 生成）")
    quoted = urllib.parse.quote(f"{fid}_workflow.json")
    return Response(
        payload,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"},
    )


@app.get("/api/export/comfy-prompt/{fid}")
def api_export_comfy_prompt(fid: str):
    it = _item(fid)
    payload = _full_meta(it).get("prompt_json")
    if not payload:
        raise HTTPException(404, "该图片没有 ComfyUI prompt JSON")
    return Response(payload, media_type="application/json")


# ---------------- 画板 ----------------

_CANVAS_SIDES = ("top", "right", "bottom", "left")
_CANVAS_COLORS = {"1", "2", "3", "4", "5", "6"}


def _cpath(p) -> str:
    try:
        return os.path.normcase(os.path.normpath(str(p)))
    except (TypeError, ValueError):
        return str(p)


def _canvas_resolve(ref: str, by_path: dict, by_name: dict, vault: str = ""):
    """文件引用 → 图库条目：绝对路径 / 库根相对路径 / 全库唯一同名。"""
    if not ref:
        return None
    raw = str(ref).replace("\\", os.sep).replace("/", os.sep)
    p = Path(raw)
    cands = [p] if p.is_absolute() else ([Path(vault) / raw] if vault else []) + [p]
    for c in cands:
        hit = by_path.get(_cpath(c))
        if hit:
            return hit
    hits = by_name.get(Path(raw).name.lower()) or []
    return hits[0] if len(hits) == 1 else None


def _parse_canvas(payload: dict, items: list, vault: str = "", reserved=None) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("不是有效的 .canvas：内容应为 JSON 对象")
    raw_nodes, raw_edges = payload.get("nodes"), payload.get("edges") or []
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        raise ValueError("不是有效的 .canvas：缺少 nodes / edges 数组")

    by_path, by_name = {}, {}
    for it in items:
        by_path[_cpath(it["path"])] = it
        by_name.setdefault(Path(it["path"]).name.lower(), []).append(it)

    used = set(reserved or ())
    id_map, nodes, edges, missing = {}, [], [], []
    skipped_edges = 0

    def num(v, dv):
        try:
            return float(v)
        except (TypeError, ValueError):
            return dv

    for rn in raw_nodes:
        if not isinstance(rn, dict):
            continue
        original = str(rn.get("id") or "").strip()
        nid = original or "n" + uuid.uuid4().hex[:10]
        while nid in used:
            nid = "n" + uuid.uuid4().hex[:10]
        used.add(nid)
        id_map[original] = nid
        id_map.setdefault(nid, nid)

        ntype = str(rn.get("type") or "text")
        x, y = round(num(rn.get("x"), 0)), round(num(rn.get("y"), 0))
        w = max(60, round(num(rn.get("width"), 260)))
        h = max(40, round(num(rn.get("height"), 180)))
        if ntype == "text":
            node = {"id": nid, "type": "text", "text": str(rn.get("text") or ""),
                    "x": x, "y": y, "w": w, "h": h}
        elif ntype == "file":
            ref = str(rn.get("file") or "")
            hit = _canvas_resolve(ref, by_path, by_name, vault)
            node = {"id": nid, "type": "image", "x": x, "y": y, "w": w, "h": h}
            if hit:
                node["fileId"] = hit["id"]
            else:
                node.update({"fileId": "", "missing": True, "path": ref})
                missing.append(ref or "（空文件名）")
        elif ntype == "link":
            node = {"id": nid, "type": "link", "url": str(rn.get("url") or ""),
                    "x": x, "y": y, "w": w, "h": h}
        elif ntype == "group":
            node = {"id": nid, "type": "group", "label": str(rn.get("label") or ""),
                    "x": x, "y": y, "w": w, "h": h}
        else:
            continue
        color = str(rn.get("color") or "")
        if color in _CANVAS_COLORS:
            node["color"] = color
        nodes.append(node)

    node_ids = {n["id"] for n in nodes}
    for re_ in raw_edges:
        if not isinstance(re_, dict):
            continue
        f = id_map.get(str(re_.get("fromNode") or ""), str(re_.get("fromNode") or ""))
        t = id_map.get(str(re_.get("toNode") or ""), str(re_.get("toNode") or ""))
        if f not in node_ids or t not in node_ids:
            skipped_edges += 1
            continue
        fs = str(re_.get("fromSide") or "right")
        ts = str(re_.get("toSide") or "left")
        edge = {
            "id": str(re_.get("id") or "") or "e" + uuid.uuid4().hex[:10],
            "from": {"node": f, "side": fs if fs in _CANVAS_SIDES else "right"},
            "to": {"node": t, "side": ts if ts in _CANVAS_SIDES else "left"},
        }
        if re_.get("label"):
            edge["label"] = str(re_["label"])
        color = str(re_.get("color") or "")
        if color in _CANVAS_COLORS:
            edge["color"] = color
        for k in ("fromEnd", "toEnd"):
            if re_.get(k):
                edge[k] = str(re_[k])
        edges.append(edge)

    return {"items": nodes, "edges": edges, "missing": missing, "skipped_edges": skipped_edges}

class BoardIn(BaseModel):
    name: str = None
    items: list = None
    edges: list = None


@app.get("/api/boards")
def api_boards():
    return {"boards": store.boards()}


@app.post("/api/boards")
def api_create_board(body: BoardIn):
    bid = store.create_board(body.name or "未命名画板")
    return {"id": bid}


@app.get("/api/boards/{bid}")
def api_get_board(bid: int):
    b = store.board(bid)
    if not b:
        raise HTTPException(404, "画板不存在")
    return _mask_hidden_nodes(b)


@app.put("/api/boards/{bid}")
def api_save_board(bid: int, body: BoardIn):
    if not store.board(bid):
        raise HTTPException(404, "画板不存在")
    items = body.items
    if isinstance(items, list):
        prev = {str(it.get("id")): it for it in ((store.board(bid) or {}).get("items") or [])}
        clean = []
        for it in items:
            if not isinstance(it, dict):
                continue
            # hidden 只是读取时的遮罩状态，不能存进库，否则隐私模式再开也回不来
            it = {k: v for k, v in it.items() if k != "hidden"}
            # 遮罩过的节点缺 path/src：从库里补回来，别因为一次保存就永久丢掉
            old = prev.get(str(it.get("id"))) or {}
            for key in ("path", "src"):
                if not it.get(key) and old.get(key):
                    it[key] = old[key]
            clean.append(it)
        items = clean
    store.save_board(bid, body.name, items, body.edges)
    return {"ok": True}


@app.delete("/api/boards/{bid}")
def api_del_board(bid: int):
    store.delete_board(bid)
    return {"ok": True}


class CanvasImportIn(BaseModel):
    canvas: dict
    vault: str = ""
    mode: str = "append"     # append（默认，追加到当前画板）| replace


@app.get("/api/graph/{fid}")
def api_graph(fid: str):
    """ComfyUI 节点图：归一成可渲染的节点与连线，供详情页预览。

    数据来自图片内嵌的 workflow（UI 格式，有排版）与 prompt（API 格式，有参数名）。
    """
    it = _item(fid)
    graph = read_graph_for_file(it["path"])
    graph["id"] = fid
    graph["name"] = it["name"]
    return graph


class GraphImportIn(BaseModel):
    fid: str = ""          # 有 fid 时把这张图本身也接到输出节点后面
    replace: bool = False  # True 用节点图替换当前画板内容


@app.post("/api/boards/{bid}/import-graph")
def api_import_graph(bid: int, body: GraphImportIn):
    """把 ComfyUI 节点图放进画板：节点、参数、连线都变成画板节点与边。"""
    b = store.board(bid)
    if not b:
        raise HTTPException(404, "画板不存在")
    if not _items_by_id:
        _refresh()

    fid = (body.fid or "").strip()
    if not fid:
        raise HTTPException(400, "缺少图片 id")
    it = _item(fid)
    graph = read_graph_for_file(it["path"])
    if not graph.get("ok"):
        raise HTTPException(400, graph.get("note") or "这张图里没有 ComfyUI 节点图")

    base_items = [] if body.replace else b["items"]
    base_edges = [] if body.replace else b["edges"]
    reserved = {n["id"] for n in base_items}
    built = graph_to_board(graph, fid=fid, reserved=reserved)

    items = base_items + built["items"]
    edges = base_edges + built["edges"]
    store.save_board(bid, None, items, edges)
    return {
        "ok": True,
        "board": store.board(bid),
        "nodes": len(built["items"]),
        "edges": len(built["edges"]),
        "source": graph.get("source"),
        "imageNode": (built.get("imageNode") or {}).get("id"),
    }


@app.get("/api/export/canvas/{bid}")
def api_export_canvas(bid: int, vault: str = ""):
    """导出 Obsidian Canvas 格式（.canvas）。

    vault 传入 Obsidian 库根目录时，图片写成库内相对路径（Obsidian 能直接解析）；
    不传则退回绝对路径。
    """
    b = store.board(bid)
    if not b:
        raise HTTPException(404, "画板不存在")
    b = _mask_hidden_nodes(b)
    if not _items_by_id:
        _refresh()
    data = board_to_canvas(b, {k: v for k, v in _items_by_id.items() if not _hidden(v)},
                           vault=vault)
    payload = json.dumps(data, ensure_ascii=False, indent=1)
    quoted = urllib.parse.quote(f"{b['name']}.canvas")
    return Response(
        payload,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"},
    )


@app.post("/api/boards/{bid}/import-canvas")
def api_import_canvas(bid: int, body: CanvasImportIn):
    """把 Obsidian .canvas JSON 导入画板，写入数据库并返回最新画板。"""
    b = store.board(bid)
    if not b:
        raise HTTPException(404, "画板不存在")
    if not _items_list:
        _refresh()
    replace = body.mode == "replace"
    base_items = [] if replace else b["items"]
    base_edges = [] if replace else b["edges"]
    try:
        parsed = _parse_canvas(body.canvas, _items_list, body.vault,
                               {it["id"] for it in base_items})
    except ValueError as e:
        raise HTTPException(400, str(e))
    items = base_items + parsed["items"]
    edges = base_edges + parsed["edges"]
    store.save_board(bid, None, items, edges)
    saved = store.board(bid)
    return {
        "ok": True,
        "board": saved,
        "imported": len(parsed["items"]),
        "imported_edges": len(parsed["edges"]),
        "missing": parsed["missing"],
        "skipped_edges": parsed["skipped_edges"],
    }


@app.get("/api/export/board/{bid}")
def api_export_board(bid: int, full: bool = False):
    b = store.board(bid)
    if not b:
        raise HTTPException(404, "画板不存在")
    b = _mask_hidden_nodes(b)
    if not _items_by_id:
        _refresh()
    suffix = "_full" if full else ""
    out = DATA_DIR / f"board_{bid}{suffix}.html"
    board_to_html(b, {k: v for k, v in _items_by_id.items() if not _hidden(v)},
                  out, full=full)
    quoted = urllib.parse.quote(f"{b['name']}.html")
    return FileResponse(
        out, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"}
    )


# ---------------- 静态 Web UI ----------------

app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
