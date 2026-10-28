"""导出：A1111 parameters 文本 / ComfyUI workflow JSON / Obsidian .canvas / 画板自包含 HTML。"""
import base64
import html
import mimetypes
from pathlib import Path

from .thumbnails import get_thumbnail

# NovelAI 采样器名 → A1111 名称（导出 A1111 文本时贴回 WebUI 可识别）
NAI_SAMPLER_MAP = {
    "k_euler": "Euler", "k_euler_ancestral": "Euler a", "k_heun": "Heun",
    "k_dpm_2": "DPM 2", "k_dpm_2_a": "DPM 2 a",
    "k_dpmpp_2s_ancestral": "DPM++ 2S a", "k_dpmpp_2m": "DPM++ 2M",
    "k_dpmpp_2m_sde": "DPM++ 2M SDE", "k_dpmpp_3m_sde": "DPM++ 3M SDE",
    "ddim": "DDIM", "plms": "PLMS",
}

# Obsidian Canvas 内置色板（1..6），前端 board.js 用同一套
CANVAS_COLORS = {"1", "2", "3", "4", "5", "6"}


def to_a1111_text(meta: dict) -> str:
    """统一元数据 → A1111 parameters 文本（可粘贴回 WebUI 的 PNG Info）。"""
    prompt = meta.get("prompt", "")
    negative = meta.get("negative", "")
    params = dict(meta.get("params", {}))
    if meta.get("source") == "novelai" and params.get("sampler") in NAI_SAMPLER_MAP:
        params["sampler"] = NAI_SAMPLER_MAP[params["sampler"]]
    setting = meta.get("setting", "")
    # 已是 A1111 文本来源时优先用原始 setting（信息更全）
    if meta.get("source") == "a1111" and setting:
        return "\n".join(x for x in [prompt, f"Negative prompt: {negative}" if negative else "", setting] if x)
    parts = []
    if params.get("steps"):
        parts.append(f"Steps: {params['steps']}")
    if params.get("sampler"):
        parts.append(f"Sampler: {params['sampler']}")
    if params.get("cfg"):
        parts.append(f"CFG scale: {params['cfg']}")
    if params.get("seed"):
        parts.append(f"Seed: {params['seed']}")
    if params.get("size"):
        parts.append(f"Size: {params['size']}")
    if params.get("model"):
        parts.append(f"Model: {params['model']}")
    lines = [x for x in [prompt, f"Negative prompt: {negative}" if negative else ""] if x]
    if parts:
        lines.append(", ".join(parts))
    return "\n".join(lines)


def asset_id(node: dict) -> str:
    """节点的图片资源 id：新模型用 fileId，老数据回退节点 id。"""
    return str(node.get("fileId") or node.get("id") or "")


def _radius(node: dict) -> dict:
    try:
        return {"x": round(float(node.get("x", 0))), "y": round(float(node.get("y", 0))),
                "w": round(float(node.get("w", 240))), "h": round(float(node.get("h", 160)))}
    except (TypeError, ValueError):
        return {"x": 0, "y": 0, "w": 240, "h": 160}


def _canvas_file_ref(path: str, vault: str = "") -> str:
    """Obsidian 的 file 字段：库内相对路径（正斜杠）优先，否则绝对路径兜底。"""
    p = Path(path)
    if vault:
        try:
            return p.relative_to(Path(vault).resolve()).as_posix()
        except (ValueError, OSError):
            pass
    return p.as_posix()


def _comfy_text(node: dict) -> str:
    """comfy 节点 → 可读文本（导出 .canvas 时用它当 text 节点，往返不丢信息）。"""
    head = node.get("title") or node.get("cls") or "Node"
    cls = node.get("cls") or ""
    lines = [f"{head}" if head == cls else f"{head} ({cls})"]
    if node.get("muted"):
        lines.append("（已静音）")
    for w in node.get("widgets") or []:
        if not isinstance(w, dict):
            continue
        k, v = str(w.get("k") or ""), str(w.get("v") or "")
        if v:
            lines.append(f"{k}: {v}" if k else v)
    return "\n".join(lines)


def board_to_canvas(board: dict, items_by_id: dict, vault: str = "") -> dict:
    """画板 → Obsidian Canvas dict。

    节点 id 用画板节点 id（不是图片 fid），图片资源单独通过 fileId 查路径；
    端点不存在的边直接丢弃，避免 Obsidian 打开时报悬空边。
    comfy 节点（ComfyUI 节点图的节点）导出成 text 节点，参数写在文本里。
    """
    nodes = []
    for it in board.get("items", []):
        pos = _radius(it)
        color = str(it.get("color") or "")
        if it.get("type") in ("text", "md"):
            node = {"id": it["id"], "type": "text", "text": it.get("text", ""),
                    "x": pos["x"], "y": pos["y"], "width": pos["w"], "height": pos["h"]}
        elif it.get("type") == "comfy":
            node = {"id": it["id"], "type": "text",
                    "text": _comfy_text(it) or it.get("title", "Node"),
                    "x": pos["x"], "y": pos["y"], "width": pos["w"], "height": pos["h"]}
        elif it.get("type") in ("image", "file"):
            info = items_by_id.get(asset_id(it))
            ref = info["path"] if info else it.get("path") or it.get("src")
            if not ref:
                continue    # 缺失图片又无原始路径：不导出成坏节点
            node = {"id": it["id"], "type": "file", "file": _canvas_file_ref(ref, vault),
                    "x": pos["x"], "y": pos["y"], "width": pos["w"], "height": pos["h"]}
        elif it.get("type") == "link":
            node = {"id": it["id"], "type": "link", "url": it.get("url", ""),
                    "x": pos["x"], "y": pos["y"], "width": pos["w"], "height": pos["h"]}
        elif it.get("type") == "group":
            node = {"id": it["id"], "type": "group", "label": it.get("label", ""),
                    "x": pos["x"], "y": pos["y"], "width": pos["w"], "height": pos["h"]}
        else:
            continue
        if color in CANVAS_COLORS:
            node["color"] = color
        nodes.append(node)

    node_ids = {n["id"] for n in nodes}
    edges = []
    for e in board.get("edges", []):
        f = (e.get("from") or {}).get("node")
        t = (e.get("to") or {}).get("node")
        if f not in node_ids or t not in node_ids:
            continue
        out = {
            "id": e.get("id") or f"e{len(edges)}",
            "fromNode": f, "fromSide": (e.get("from") or {}).get("side") or "right",
            "toNode": t, "toSide": (e.get("to") or {}).get("side") or "left",
        }
        if e.get("label"):
            out["label"] = str(e["label"])
        if str(e.get("color") or "") in CANVAS_COLORS:
            out["color"] = str(e["color"])
        if e.get("fromEnd"):
            out["fromEnd"] = e["fromEnd"]
        if e.get("toEnd"):
            out["toEnd"] = e["toEnd"]
        edges.append(out)
    return {"nodes": nodes, "edges": edges, "version": "1.0"}


# ---------------- 自包含 HTML ----------------

# 与 board.js 完全一致的贝塞尔算法（导出后视觉一致）
_HTML_JS = r"""
const wrap=document.getElementById('wrap'),stage=document.getElementById('stage');
const VIEW={s:1,x:0,y:0};
function apply(){stage.style.transform='translate('+VIEW.x+'px,'+VIEW.y+'px) scale('+VIEW.s+')';}
wrap.addEventListener('wheel',e=>{
  e.preventDefault();
  const r=wrap.getBoundingClientRect(),cx=e.clientX-r.left,cy=e.clientY-r.top;
  const old=VIEW.s,next=Math.min(4,Math.max(0.08,old*(e.deltaY<0?1.12:1/1.12)));
  VIEW.x=cx-((cx-VIEW.x)/old)*next;VIEW.y=cy-((cy-VIEW.y)/old)*next;VIEW.s=next;apply();
},{passive:false});
wrap.addEventListener('mousedown',e=>{
  if(e.button!==0&&e.button!==1)return;
  const sx=e.clientX-VIEW.x,sy=e.clientY-VIEW.y;
  const mv=ev=>{VIEW.x=ev.clientX-sx;VIEW.y=ev.clientY-sy;apply();};
  const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
  e.preventDefault();
});
apply();
"""


def _svg_edge_path(p1: dict, s1: str, p2: dict, s2: str) -> str:
    dx, dy = abs(p2["x"] - p1["x"]), abs(p2["y"] - p1["y"])
    h = max(40, (dx if s1 in ("left", "right") else dy) * 0.5)
    c1 = (p1["x"] - h, p1["y"]) if s1 == "left" else (p1["x"] + h, p1["y"]) if s1 == "right" \
        else (p1["x"], p1["y"] - h) if s1 == "top" else (p1["x"], p1["y"] + h)
    c2 = (p2["x"] - h, p2["y"]) if s2 == "left" else (p2["x"] + h, p2["y"]) if s2 == "right" \
        else (p2["x"], p2["y"] - h) if s2 == "top" else (p2["x"], p2["y"] + h)
    return (f"M {p1['x']} {p1['y']} C {c1[0]} {c1[1]}, {c2[0]} {c2[1]}, "
            f"{p2['x']} {p2['y']}")


def _anchor(node: dict, side: str) -> dict:
    pos = _radius(node)
    return {
        "top": {"x": pos["x"] + pos["w"] / 2, "y": pos["y"]},
        "bottom": {"x": pos["x"] + pos["w"] / 2, "y": pos["y"] + pos["h"]},
        "left": {"x": pos["x"], "y": pos["y"] + pos["h"] / 2},
        "right": {"x": pos["x"] + pos["w"], "y": pos["y"] + pos["h"] / 2},
    }.get(side, {"x": pos["x"] + pos["w"] / 2, "y": pos["y"] + pos["h"] / 2})


def board_to_html(board: dict, items_by_id: dict, out: Path, full: bool = False):
    """画板 → 自包含 HTML：图片节点 + 文本节点 + 连线（含标签/颜色/箭头），可平移缩放。"""
    nodes = {it["id"]: it for it in board.get("items", [])}
    parts = []
    for it in board.get("items", []):
        pos = _radius(it)
        color = str(it.get("color") or "")
        cls = f" item c{color}" if color in CANVAS_COLORS else " item"
        style = (f"left:{pos['x']}px;top:{pos['y']}px;"
                 f"width:{pos['w']}px;height:{pos['h']}px")
        if it.get("type") == "text":
            body = html.escape(it.get("text", "")).replace("\n", "<br>")
            parts.append(f'<div class="{cls.strip()} txt" style="{style}">{body}</div>')
            continue
        if it.get("type") == "md":
            body = html.escape(it.get("text", ""))
            parts.append(f'<div class="{cls.strip()} txt md" style="{style}">{body}</div>')
            continue
        if it.get("type") == "comfy":
            title = html.escape(str(it.get("title") or it.get("cls") or "Node"))
            rows = []
            for w in it.get("widgets") or []:
                if not isinstance(w, dict) or not w.get("v"):
                    continue
                k = html.escape(str(w.get("k") or ""))
                v = html.escape(str(w.get("v") or ""))
                rows.append(f'<div class="w"><span>{k}</span><b>{v}</b></div>' if k
                            else f'<div class="w"><b>{v}</b></div>')
            parts.append(
                f'<div class="{cls.strip()} comfy" style="{style}">'
                f'<div class="h">{title}</div>{"".join(rows)}</div>')
            continue
        if it.get("type") in ("link", "group"):
            label = html.escape(it.get("url") or it.get("label") or "")
            parts.append(f'<div class="{cls.strip()} txt" style="{style}">🔗 {label}</div>')
            continue
        info = items_by_id.get(asset_id(it))
        if info:
            try:
                if full:
                    src_path = Path(info["path"])
                    mime = mimetypes.guess_type(info["path"])[0] or "image/png"
                else:
                    src_path = Path(get_thumbnail(Path(info["path"]), info["id"]))
                    mime = "image/jpeg"
                b64 = base64.b64encode(src_path.read_bytes()).decode()
                meta = info.get("meta", {})
                title = html.escape((meta.get("prompt") or info["name"])[:120])
                parts.append(f'<div class="{cls.strip()}" style="{style}" title="{title}">'
                             f'<img src="data:{mime};base64,{b64}" alt=""></div>')
                continue
            except (OSError, ValueError):
                pass
        name = html.escape(Path(it.get("path") or it.get("src") or "缺失图片").name)
        parts.append(f'<div class="{cls.strip()} missing" style="{style}">'
                     f'<span>图片缺失<br>{name}</span></div>')

    # 连线层（几何用世界坐标，与节点同层）
    edge_svg = []
    for e in board.get("edges", []):
        a, b = nodes.get((e.get("from") or {}).get("node")), nodes.get((e.get("to") or {}).get("node"))
        if not a or not b:
            continue
        p1 = _anchor(a, (e.get("from") or {}).get("side", "right"))
        p2 = _anchor(b, (e.get("to") or {}).get("side", "left"))
        d = _svg_edge_path(p1, (e.get("from") or {}).get("side", "right"),
                           p2, (e.get("to") or {}).get("side", "left"))
        color = str(e.get("color") or "")
        stroke = f"var(--c{color})" if color in CANVAS_COLORS else "#9a9aa2"
        marker = ' marker-end="url(#arrow)"' if e.get("toEnd") == "arrow" else ""
        edge_svg.append(f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="2"{marker}/>')
        if e.get("label"):
            mx, my = (p1["x"] + p2["x"]) / 2, (p1["y"] + p2["y"]) / 2
            edge_svg.append(
                f'<text x="{mx}" y="{my}" class="elabel">{html.escape(str(e["label"]))}</text>')

    svg = ""
    if edge_svg:
        svg = ('<svg class="edges" width="1" height="1">'
               '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"'
               ' markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
               '<path d="M0,0 L10,5 L0,10 z" fill="#9a9aa2"/></marker></defs>'
               + "".join(edge_svg) + "</svg>")

    doc = f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>{html.escape(board["name"])} · Texture 画板</title>
<style>
:root{{--c1:#fb464c;--c2:#e9973f;--c3:#e0de71;--c4:#44cf6e;--c5:#53dfdd;--c6:#a882ff;
  color-scheme:dark}}
*{{box-sizing:border-box}}
html,body{{margin:0;height:100%;overflow:hidden;background:#17171b;
  font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#e6e6ea}}
#wrap{{position:absolute;inset:0;cursor:grab}}
#stage{{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0}}
.item{{position:absolute;overflow:hidden;border-radius:8px;background:#202026;
  border:1px solid #34343c;box-shadow:0 8px 28px #0007}}
.item img{{width:100%;height:100%;object-fit:contain;display:block}}
.item.txt{{padding:12px 14px;white-space:pre-wrap;word-break:break-word;overflow:auto;
  background:#26262e;font-size:13px}}
.item.missing{{display:flex;align-items:center;justify-content:center;text-align:center;
  color:#8b8b95;font-size:12px;border-style:dashed;background:#1d1d23}}
.item.comfy{{padding:0;overflow:auto;background:#202026;font-size:11.5px;
  line-height:1.5}}
.item.comfy .h{{position:sticky;top:0;padding:5px 8px;background:#2c2c34;
  border-bottom:1px solid #3a3a44;font-weight:700;font-size:11.5px;
  letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.item.comfy .w{{display:flex;gap:6px;padding:2px 8px;border-bottom:1px solid #26262e}}
.item.comfy .w span{{flex:none;min-width:64px;color:#8b8b95}}
.item.comfy .w b{{font-weight:400;color:#d7d8dd;word-break:break-word}}
.item.c1{{border-color:var(--c1)}} .item.c2{{border-color:var(--c2)}}
.item.c3{{border-color:var(--c3)}} .item.c4{{border-color:var(--c4)}}
.item.c5{{border-color:var(--c5)}} .item.c6{{border-color:var(--c6)}}
.edges{{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}}
.elabel{{fill:#a9a9b3;font-size:11px;text-anchor:middle;dominant-baseline:middle}}
h1{{position:fixed;left:16px;top:14px;margin:0;font-size:12px;font-weight:500;
  letter-spacing:.04em;color:#8b8b95;z-index:9;pointer-events:none}}
</style></head><body>
<div id="wrap"><div id="stage">{svg}{''.join(parts)}
</div></div>
<h1>{html.escape(board["name"])} · 由 Texture 导出</h1>
<script>{_HTML_JS}</script>
</body></html>"""
    out.write_text(doc, encoding="utf-8")
    return out