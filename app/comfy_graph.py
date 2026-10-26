"""ComfyUI 节点图：把 workflow / prompt JSON 归一成可渲染的节点图，并可转成画板节点。

- workflow（UI 格式）：有 pos / size / links，能还原作者当时的排版
- prompt（API 格式）：有具名输入，能知道每个参数叫什么

两者都有时按节点 id 合起来用：几何来自 workflow，参数名来自 prompt。
只有 prompt 时用分层布局自动排一遍。
"""
import json
from pathlib import Path

DEFAULT_W = 315
DEFAULT_H = 120
MIN_W = 140
MIN_H = 60
VALUE_MAX = 160

# 产出图片的节点
OUTPUT_TYPES = ("SaveImage", "PreviewImage", "Image Save", "SDPromptSaver")

MODE_MUTED = 2
MODE_BYPASS = 4


def _load(raw):
    if not raw:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(str(raw))
    except (TypeError, ValueError):
        return None


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return float(default)


def _xy(v, dx=0.0, dy=0.0):
    if isinstance(v, (list, tuple)) and len(v) >= 2:
        return _num(v[0], dx), _num(v[1], dy)
    if isinstance(v, dict):
        return _num(v.get("x", v.get("0", dx)), dx), _num(v.get("y", v.get("1", dy)), dy)
    return float(dx), float(dy)


def _wh(v, dw=DEFAULT_W, dh=DEFAULT_H):
    if isinstance(v, (list, tuple)) and len(v) >= 2:
        return _num(v[0], dw), _num(v[1], dh)
    if isinstance(v, dict):
        w = v.get("width", v.get("w", v.get("0", dw)))
        h = v.get("height", v.get("h", v.get("1", dh)))
        return _num(w, dw), _num(h, dh)
    return float(dw), float(dh)


def _short(v):
    if isinstance(v, bool):
        return "开" if v else "关"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (list, tuple)):
        return ", ".join(_short(x) for x in v)
    s = " ".join(str(v).replace("\r\n", "\n").split())
    return s[:VALUE_MAX] + ("…" if len(s) > VALUE_MAX else "")


def _widgets(raw):
    if isinstance(raw, dict):
        return [{"k": str(k), "v": _short(v)} for k, v in raw.items()]
    if isinstance(raw, (list, tuple)):
        return [{"k": "", "v": _short(v)} for v in raw]
    return []


def _is_link(v):
    return (isinstance(v, (list, tuple)) and len(v) == 2
            and isinstance(v[0], (str, int)) and not isinstance(v[0], bool)
            and isinstance(v[1], int) and not isinstance(v[1], bool))


def _node_title(node):
    title = node.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    return str(node.get("type") or node.get("class_type") or "Node")


def _prompt_inputs(prompt):
    out = {}
    if not isinstance(prompt, dict):
        return out
    for nid, node in prompt.items():
        if not isinstance(node, dict):
            continue
        ins = node.get("inputs")
        if not isinstance(ins, dict):
            continue
        out[str(nid)] = {k: v for k, v in ins.items() if not _is_link(v)}
    return out


def _label_from_prompt(widgets, named):
    """给没有名字的 widget 值配名字：先按值相等配，剩下的按顺序配。"""
    if not widgets or not named:
        return widgets
    pool = list(named.items())
    used = set()
    for w in widgets:
        if w["k"]:
            continue
        for i, (_k, v) in enumerate(pool):
            if i in used:
                continue
            if _short(v) == w["v"]:
                used.add(i)
                w["k"] = pool[i][0]
                break
    taken = {x["k"] for x in widgets if x["k"]}
    rest = [k for i, (k, _v) in enumerate(pool) if i not in used and k not in taken]
    for w in widgets:
        if w["k"]:
            continue
        while rest:
            k = rest.pop(0)
            if k in taken:
                continue
            taken.add(k)
            w["k"] = k
            break
    return widgets


def _links_from_workflow(raw_links):
    """UI 格式：[[id, 起点节点, 起点槽, 终点节点, 终点槽, 类型], ...]"""
    out = []
    for item in raw_links or []:
        if isinstance(item, (list, tuple)) and len(item) >= 5:
            out.append({
                "id": str(item[0]),
                "from": str(item[1]),
                "fromSlot": int(_num(item[2])),
                "to": str(item[3]),
                "toSlot": int(_num(item[4])),
                "type": str(item[5]) if len(item) > 5 and item[5] is not None else "",
            })
        elif isinstance(item, dict):
            frm = item.get("origin_id", item.get("from"))
            to = item.get("target_id", item.get("to"))
            if frm is None or to is None:
                continue
            out.append({
                "id": str(item.get("id", f"{frm}-{to}")),
                "from": str(frm),
                "fromSlot": int(_num(item.get("origin_slot", item.get("fromSlot", 0)))),
                "to": str(to),
                "toSlot": int(_num(item.get("target_slot", item.get("toSlot", 0)))),
                "type": str(item.get("type", "")),
            })
    return out


def _links_from_prompt(prompt):
    """API 格式：输入值是 ["节点 id", 槽位] 就是一条连线。"""
    out = []
    if not isinstance(prompt, dict):
        return out
    for nid, node in prompt.items():
        if not isinstance(node, dict):
            continue
        ins = node.get("inputs")
        if not isinstance(ins, dict):
            continue
        for slot, (key, val) in enumerate(ins.items()):
            if not _is_link(val):
                continue
            out.append({
                "id": f"{val[0]}:{val[1]}->{nid}:{slot}",
                "from": str(val[0]),
                "fromSlot": int(val[1]),
                "to": str(nid),
                "toSlot": slot,
                "type": key,
            })
    return out


def _layers(nodes, links):
    """按最长路径分层，供自动布局用；遇到环就地打断。"""
    ids = [n["id"] for n in nodes]
    incoming = {i: [] for i in ids}
    for l in links:
        if l["from"] in incoming and l["to"] in incoming:
            incoming[l["to"]].append(l["from"])
    depth = {}

    def walk(nid, seen):
        if nid in depth:
            return depth[nid]
        if nid in seen:
            return 0
        seen.add(nid)
        ups = incoming.get(nid) or []
        d = 0 if not ups else 1 + max(walk(u, seen) for u in ups)
        seen.discard(nid)
        depth[nid] = d
        return d

    for i in ids:
        walk(i, set())
    return depth


def _auto_layout(nodes, links):
    depth = _layers(nodes, links)
    col = {}
    for n in nodes:
        d = depth.get(n["id"], 0)
        idx = col.get(d, 0)
        col[d] = idx + 1
        n["x"] = 60 + d * (DEFAULT_W + 110)
        n["y"] = 60 + idx * (DEFAULT_H + 60)
    return nodes


def _graph_from_workflow(wf, prompt_map):
    raw_nodes = wf.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        return None
    nodes, seen = [], set()
    for rn in raw_nodes:
        if not isinstance(rn, dict):
            continue
        nid = rn.get("id")
        if nid is None or str(nid) in seen:
            continue
        seen.add(str(nid))
        x, y = _xy(rn.get("pos"))
        w, h = _wh(rn.get("size"))
        widgets = _widgets(rn.get("widgets_values"))
        named = prompt_map.get(str(nid)) or {}
        if named:
            widgets = _label_from_prompt(widgets, named)
        mode = int(_num(rn.get("mode"), 0))
        nodes.append({
            "id": str(nid),
            "type": str(rn.get("type") or rn.get("class_type") or "Node"),
            "title": _node_title(rn),
            "x": round(x),
            "y": round(y),
            "w": max(MIN_W, round(w)),
            "h": max(MIN_H, round(h)),
            "widgets": widgets,
            "mode": mode,
            "muted": mode in (MODE_MUTED, MODE_BYPASS),
        })
    if not nodes:
        return None
    groups = []
    for g in wf.get("groups") or []:
        if not isinstance(g, dict):
            continue
        b = g.get("bounding") or []
        if not isinstance(b, (list, tuple)) or len(b) < 4:
            continue
        groups.append({
            "title": str(g.get("title") or "分组"),
            "x": round(_num(b[0])),
            "y": round(_num(b[1])),
            "w": max(MIN_W, round(_num(b[2]))),
            "h": max(MIN_H, round(_num(b[3]))),
        })
    return {
        "nodes": nodes,
        "links": _links_from_workflow(wf.get("links")),
        "groups": groups,
        "source": "workflow",
    }


def _graph_from_prompt(prompt):
    if not isinstance(prompt, dict) or not prompt:
        return None
    nodes = []
    for nid, node in prompt.items():
        if not isinstance(node, dict):
            continue
        ins = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        widgets = [{"k": k, "v": _short(v)} for k, v in ins.items() if not _is_link(v)]
        ntype = str(node.get("class_type") or "Node")
        h = DEFAULT_H + min(6, len(widgets)) * 18
        nodes.append({
            "id": str(nid),
            "type": ntype,
            "title": _node_title(node),
            "x": 0,
            "y": 0,
            "w": DEFAULT_W,
            "h": max(MIN_H, h),
            "widgets": widgets,
            "mode": 0,
            "muted": False,
        })
    links = _links_from_prompt(prompt)
    _auto_layout(nodes, links)
    return {"nodes": nodes, "links": links, "groups": [], "source": "prompt"}


def build_graph(workflow_raw=None, prompt_raw=None):
    """归一成 {ok, nodes, links, groups, source}。"""
    wf = _load(workflow_raw)
    prompt = _load(prompt_raw)
    prompt_map = _prompt_inputs(prompt) if isinstance(prompt, dict) else {}

    graph = None
    if isinstance(wf, dict):
        graph = _graph_from_workflow(wf, prompt_map)
    if graph is None:
        graph = _graph_from_prompt(prompt)
    if graph is None:
        return {"ok": False, "nodes": [], "links": [], "groups": [],
                "source": "none", "note": "没有可用的 ComfyUI 节点图数据"}

    ids = {n["id"] for n in graph["nodes"]}
    graph["links"] = [l for l in graph["links"] if l["from"] in ids and l["to"] in ids]
    seen, dedup = set(), []
    for l in graph["links"]:
        key = (l["from"], l["fromSlot"], l["to"], l["toSlot"])
        if key in seen:
            continue
        seen.add(key)
        dedup.append(l)
    graph["links"] = dedup
    graph["ok"] = True
    return graph


def read_graph_for_file(path):
    """直接从图片文件读节点图。"""
    from PIL import Image

    try:
        with Image.open(Path(path)) as f:
            info = dict(f.info)
    except Exception as e:
        return {"ok": False, "nodes": [], "links": [], "groups": [],
                "source": "none", "note": f"读取图片失败：{e}"}
    if "workflow" not in info and "prompt" not in info:
        return {"ok": False, "nodes": [], "links": [], "groups": [], "source": "none",
                "note": "这张图里没有 ComfyUI 节点图（不是 ComfyUI 生成的）"}
    return build_graph(info.get("workflow"), info.get("prompt"))


def _side_between(a, b):
    """按相对位置挑一对锚点，让连线从朝向对方的一侧出去。"""
    acx, acy = a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
    bcx, bcy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
    dx, dy = bcx - acx, bcy - acy
    if abs(dx) >= abs(dy):
        return ("right", "left") if dx >= 0 else ("left", "right")
    return ("bottom", "top") if dy >= 0 else ("top", "bottom")


def graph_to_board(graph, fid="", reserved=None):
    """节点图 → 画板 items / edges。

    fid 非空时把这张图作为图片节点接在输出节点后面，
    让"图"和"它的生成过程"出现在同一个画板上。
    """
    if not graph or not graph.get("nodes"):
        return {"items": [], "edges": [], "imageNode": None}

    used = set(reserved or ())
    nodes = graph["nodes"]
    min_x = min(n["x"] for n in nodes)
    min_y = min(n["y"] for n in nodes)
    offset = (-min_x + 80, -min_y + 80)

    def uid(base):
        cand, n = base, 1
        while cand in used:
            cand = f"{base}~{n}"
            n += 1
        used.add(cand)
        return cand

    items, id_map = [], {}

    for i, g in enumerate(graph.get("groups") or []):
        items.append({
            "id": uid(f"grp{i}"), "type": "group", "label": g.get("title") or "分组",
            "x": g["x"] + offset[0] - 24, "y": g["y"] + offset[1] - 44,
            "w": g["w"] + 48, "h": g["h"] + 68,
        })

    for n in nodes:
        nid = uid("c" + str(n["id"]))
        id_map[n["id"]] = nid
        widgets = [w for w in (n.get("widgets") or []) if w.get("v") not in ("", None)]
        items.append({
            "id": nid,
            "type": "comfy",
            "cls": n.get("type") or "",
            "title": n.get("title") or n.get("type") or "Node",
            "widgets": widgets[:14],
            "x": n["x"] + offset[0],
            "y": n["y"] + offset[1],
            "w": n["w"],
            "h": n["h"],
            "muted": bool(n.get("muted")),
        })

    pos = {it["id"]: it for it in items}
    edges = []
    for l in graph.get("links") or []:
        a, b = id_map.get(l["from"]), id_map.get(l["to"])
        if not a or not b or a not in pos or b not in pos:
            continue
        fs, ts = _side_between(pos[a], pos[b])
        edges.append({
            "id": uid(f"e{l.get('id', len(edges))}"),
            "from": {"node": a, "side": fs},
            "to": {"node": b, "side": ts},
            "label": l.get("type") or "",
        })

    image_node = None
    if fid:
        outs = [n for n in nodes if (n.get("type") or "") in OUTPUT_TYPES]
        anchor = outs[0] if outs else max(nodes, key=lambda n: n["x"] + n["w"])
        w = 280
        ratio = (anchor.get("h") or DEFAULT_H) / max(1, (anchor.get("w") or DEFAULT_W))
        h = max(180, min(420, round(w * max(0.7, min(1.5, ratio)))))
        image_node = {
            "id": uid("img"), "type": "image", "fileId": str(fid),
            "x": round(anchor["x"] + offset[0] + anchor["w"] + 110),
            "y": round(anchor["y"] + offset[1] + 10),
            "w": w, "h": h,
        }
        items.append(image_node)
        src_id = id_map.get(anchor["id"])
        if src_id and src_id in pos:
            fs, ts = _side_between(pos[src_id], image_node)
            edges.append({
                "id": uid("e-out"),
                "from": {"node": src_id, "side": fs},
                "to": {"node": image_node["id"], "side": ts},
                "label": "IMAGE",
            })

    return {"items": items, "edges": edges, "imageNode": image_node}
