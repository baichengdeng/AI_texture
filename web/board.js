/* Texture 白板：Obsidian Canvas 式无限画布
   - 多选 / 框选 / 成组拖动 / 批量复制删除
   - 四向锚点连线、贝塞尔边、标签 / 颜色 / 箭头
   - 平移缩放、适应全部、视口记忆、自动保存（revision 防丢改动）
   - Obsidian .canvas 导入导出，节点 id 与图片 fileId 分离
   数据模型：{id, type:"image"|"text"|"link"|"group", fileId?, x,y,w,h, text?, color?} */
"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);
  const canvas = $("#board-canvas");
  const wrap = $("#board-wrap");
  const svgNS = "http://www.w3.org/2000/svg";

  const SIDES = ["top", "right", "bottom", "left"];
  const COLORS = [
    ["", "默认"], ["1", "红"], ["2", "橙"], ["3", "黄"],
    ["4", "绿"], ["5", "青"], ["6", "紫"],
  ];
  const COLOR_HEX = {
    "1": "#fb464c", "2": "#e9973f", "3": "#e0de71",
    "4": "#44cf6e", "5": "#53dfdd", "6": "#a882ff",
  };
  const EDGE_STROKE = "#9a9aa2";
  /* 连线走线方式：贝塞尔曲线 / 90° 直角 / 45° 折角 / 直接直线 */
  const ROUTES = ["curve", "ortho", "diag", "line"];
  const ROUTE_LABEL = { curve: "曲线", ortho: "90° 直角", diag: "45° 折角", line: "直线" };
  const SIDE_DIR = {
    top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 },
    left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
  };
  const MIN_W = 24, MIN_H = 20;
  // 缩放热区固定为 16 屏幕像素，是 2px 选中轮廓的 8 倍（要求至少 5 倍）。
  const RESIZE_HIT_SCREEN = 16;

  const board = {
    id: null, name: "",
    items: [],
    edges: [],
    scale: 1, panX: 120, panY: 80,
  };

  let selection = { nodes: new Set(), edges: new Set() };
  let editingText = null;
  let spaceDown = false;
  let pendingFit = false;

  /* ---------- 工具函数 ---------- */
  const uid = (p = "n") =>
    p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const nodeById = (id) => board.items.find((n) => n.id === id);
  const edgeById = (id) => board.edges.find((e) => e.id === id);
  const baseName = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const cssId = (id) => (window.CSS && CSS.escape ? CSS.escape(id) : String(id).replace(/["\\]/g, "\\$&"));
  const nodeEl = (id) => canvas.querySelector(`.b-item[data-node="${cssId(id)}"]`);
  const edgeEl = (id) => canvas.querySelector(`g[data-edge="${cssId(id)}"]`);
  const scene = () => canvas.querySelector("svg.edge-layer");

  function normalizeNode(raw) {
    const it = { text: "", ...raw };
    it.id = String(it.id || uid());
    if (!it.type) it.type = "image";
    if (it.type === "image" && it.fileId == null) it.fileId = String(it.id);
    if (it.type === "md") it.text = String(it.text || "");
    if (it.type === "group") it.label = String(it.label || "分组");
    if (it.type === "comfy") {
      // ComfyUI 节点图的节点：标题、类型、参数列表
      it.title = String(it.title || it.cls || "Node");
      it.cls = String(it.cls || "");
      it.muted = !!it.muted;
      it.widgets = Array.isArray(it.widgets)
        ? it.widgets
            .filter((w) => w && typeof w === "object" && String(w.v || "") !== "")
            .map((w) => ({ k: String(w.k || ""), v: String(w.v) }))
        : [];
    }
    for (const [k, dv] of [["x", 0], ["y", 0], ["w", 240], ["h", 160]]) {
      const n = Number(it[k]);
      it[k] = Number.isFinite(n) ? Math.round(n) : dv;
    }
    return it;
  }

  function normalizeEdge(raw) {
    const e = { ...raw };
    e.id = String(e.id || uid("e"));
    e.from = { node: String(e.from?.node || ""), side: SIDES.includes(e.from?.side) ? e.from.side : "right" };
    e.to = { node: String(e.to?.node || ""), side: SIDES.includes(e.to?.side) ? e.to.side : "left" };
    e.route = ROUTES.includes(e.route) ? e.route : "curve";
    return e;
  }

  /* 轻量 Markdown：只支持标题、列表、引用、代码、粗体、斜体、行内代码和链接。
     全部先转义再拼标签，不引入第三方库，也不会执行内嵌 HTML。 */
  function mdToHTML(source) {
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let inCode = false, code = [], list = false;
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    const closeList = () => { if (list) { out.push("</ul>"); list = false; } };
    for (const line of lines) {
      if (/^```/.test(line)) {
        if (inCode) { out.push(`<pre>${esc(code.join("\n"))}</pre>`); code = []; }
        inCode = !inCode;
        continue;
      }
      if (inCode) { code.push(line); continue; }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        if (!list) { out.push("<ul>"); list = true; }
        out.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      closeList();
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) { out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
      if (!line.trim()) continue;
      out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    if (inCode) out.push(`<pre>${esc(code.join("\n"))}</pre>`);
    return out.join("");
  }

  const FONT_FAMILY = {
    sans: 'var(--font-text)',
    serif: '"Songti SC", "SimSun", "Noto Serif SC", serif',
    mono: 'var(--font-mono)',
  };

  function nodeTextTargets(el) {
    return el.querySelectorAll(
      ".b-text-body, .b-md-body, .b-group-label, .b-link, .b-comfy-body");
  }

  function applyNodeTextStyle(it, el) {
    for (const target of nodeTextTargets(el)) {
      target.style.color = it.textColor || "";
      target.style.fontSize = it.fontSize ? it.fontSize + "px" : "";
      target.style.textAlign = it.textAlign || "";
      target.style.lineHeight = it.lineHeight || "";
      target.style.fontFamily = it.fontFamily ? (FONT_FAMILY[it.fontFamily] || "") : "";
    }
  }

  function nodeTitle(node) {
    if (node.type === "group") return node.label || "分组";
    if (node.type === "link") return node.url || "链接";
    if (node.type === "comfy") return node.title || "ComfyUI 节点";
    const first = String(node.text || "").split("\n").find((s) => s.trim()) || "";
    return first.replace(/^#{1,6}\s*/, "").slice(0, 60) ||
      (node.type === "md" ? "未命名 Markdown" : "文本节点");
  }

  /* ---------- 视口 ---------- */
  function applyTransform() {
    canvas.style.transform = `translate(${board.panX}px, ${board.panY}px) scale(${board.scale})`;
    // 抵消画布缩放，让任意比例下的缩放热区都保持相同的屏幕宽度。
    canvas.style.setProperty("--rz-hit", `${RESIZE_HIT_SCREEN / board.scale}px`);
    $("#zoom-level").textContent = Math.round(board.scale * 100) + "%";
    saveViewportSoon();
  }

  const toWorld = (cx, cy) => {
    const r = wrap.getBoundingClientRect();
    return { x: (cx - r.left - board.panX) / board.scale, y: (cy - r.top - board.panY) / board.scale };
  };

  let viewTimer = null;
  function saveViewportSoon() {
    if (board.id == null) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      try {
        localStorage.setItem("texture.view." + board.id,
          JSON.stringify({ scale: board.scale, panX: board.panX, panY: board.panY }));
      } catch { /* 隐私模式忽略 */ }
    }, 250);
  }

  function setZoom(next, cx, cy) {
    const old = board.scale;
    next = clamp(next, 0.08, 4);
    if (Math.abs(next - old) < 1e-6) return;
    const r = wrap.getBoundingClientRect();
    const px = (cx == null ? r.left + r.width / 2 : cx) - r.left;
    const py = (cy == null ? r.top + r.height / 2 : cy) - r.top;
    board.panX = px - ((px - board.panX) / old) * next;
    board.panY = py - ((py - board.panY) / old) * next;
    board.scale = next;
    applyTransform();
    updateSelToolbar();
    applyImgSrc();
  }

  function fitView(opts = {}) {
    const r = wrap.getBoundingClientRect();
    if (!board.items.length || r.width < 40) {
      board.scale = 1; board.panX = 120; board.panY = 80;
      applyTransform(); updateSelToolbar(); return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of board.items) {
      minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + it.w); maxY = Math.max(maxY, it.y + it.h);
    }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const pad = 72;
    const fit = Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh);
    // min：整块太大时不要一路缩到看不清（节点图用它保底），缩到下限后靠平移看其余部分
    const s = clamp(fit, opts.min || 0.08, 1.5);
    board.scale = s;
    if (fit < (opts.min || 0.08)) {
      // 已经缩到下限还装不下：从左上角开始显示，而不是居中
      board.panX = pad - minX * s;
      board.panY = pad - minY * s;
    } else {
      board.panX = (r.width - bw * s) / 2 - minX * s;
      board.panY = (r.height - bh * s) / 2 - minY * s;
    }
    applyTransform(); updateSelToolbar(); applyImgSrc();
  }

  /* 把某个节点放到视口中央（按给定比例）。节点图导入后用它落在可读比例上，
     想看全貌按 F（适应全部）。 */
  function centerOn(id, scale = 0.9) {
    const n = nodeById(id);
    if (!n) return false;
    const r = wrap.getBoundingClientRect();
    if (r.width < 40) return false;
    board.scale = clamp(scale, 0.08, 4);
    board.panX = r.width / 2 - (n.x + n.w / 2) * board.scale;
    board.panY = r.height / 2 - (n.y + n.h / 2) * board.scale;
    applyTransform();
    updateSelToolbar();
    applyImgSrc();
    return true;
  }

  function zoomAtCenter(factor) { setZoom(board.scale * factor); }

  /* ---------- 几何 ---------- */
  function anchorPos(n, side) {
    if (!n) return { x: 0, y: 0 };
    return {
      top: { x: n.x + n.w / 2, y: n.y },
      bottom: { x: n.x + n.w / 2, y: n.y + n.h },
      left: { x: n.x, y: n.y + n.h / 2 },
      right: { x: n.x + n.w, y: n.y + n.h / 2 },
    }[side] || { x: n.x + n.w / 2, y: n.y + n.h / 2 };
  }

  function ctrlPoint(p, side, h) {
    if (side === "left") return { x: p.x - h, y: p.y };
    if (side === "right") return { x: p.x + h, y: p.y };
    if (side === "top") return { x: p.x, y: p.y - h };
    return { x: p.x, y: p.y + h };
  }

  /* 折线的中点：按长度走到一半，标签就放在这里 */
  function polyMid(pts) {
    if (!pts.length) return { x: 0, y: 0 };
    const segs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      segs.push(l);
      total += l;
    }
    if (total < 0.01) return pts[0];
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      if (acc + segs[i] >= total / 2) {
        const t = segs[i] ? (total / 2 - acc) / segs[i] : 0;
        return {
          x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
          y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
        };
      }
      acc += segs[i];
    }
    return pts[pts.length - 1];
  }

  /* 去掉重复点与「三点共线」的中间点，路径干净，也少几个 DOM 属性数字 */
  function dedupePts(pts) {
    const out = pts.filter((p, i) =>
      i === 0 || Math.abs(p.x - pts[i - 1].x) > 0.01 || Math.abs(p.y - pts[i - 1].y) > 0.01);
    return out.filter((p, i) => {
      if (i === 0 || i === out.length - 1) return true;
      const a = out[i - 1], b = out[i + 1];
      const cross = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
      return Math.abs(cross) > 0.01;
    });
  }

  /* 90° 直角：两端各走一小段出口（stub），中间按两边朝向补拐点 */
  function orthoRaw(p1, s1, p2, s2) {
    const stub = 22;
    const d1 = SIDE_DIR[s1] || SIDE_DIR.right;
    const d2 = SIDE_DIR[s2] || SIDE_DIR.left;
    const a = { x: p1.x + d1.x * stub, y: p1.y + d1.y * stub };
    const b = { x: p2.x + d2.x * stub, y: p2.y + d2.y * stub };
    const h1 = d1.x !== 0, h2 = d2.x !== 0;
    const pts = [p1, a];
    if (h1 && h2) {
      const mx = (a.x + b.x) / 2;
      pts.push({ x: mx, y: a.y }, { x: mx, y: b.y });
    } else if (!h1 && !h2) {
      const my = (a.y + b.y) / 2;
      pts.push({ x: a.x, y: my }, { x: b.x, y: my });
    } else if (h1) {
      pts.push({ x: b.x, y: a.y });
    } else {
      pts.push({ x: a.x, y: b.y });
    }
    pts.push(b, p2);
    return pts;
  }

  function orthoPoints(p1, s1, p2, s2) {
    return dedupePts(orthoRaw(p1, s1, p2, s2));
  }

  /* 45° 折角：从两端出口点之间插一段斜线，其余仍走直角 */
  function diagPoints(p1, s1, p2, s2) {
    const raw = orthoRaw(p1, s1, p2, s2);
    const start = raw[1];
    const end = raw[raw.length - 2];
    const dx = end.x - start.x, dy = end.y - start.y;
    const L = Math.min(Math.abs(dx), Math.abs(dy));
    if (L < 6) return dedupePts(raw);          // 几乎对齐，斜不出来
    const m = { x: start.x + Math.sign(dx) * L, y: start.y + Math.sign(dy) * L };
    return dedupePts([p1, start, m, end, p2]);
  }

  const ptsToPath = (pts) =>
    pts.map((p, i) => `${i ? "L" : "M"} ${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`)
      .join(" ");

  function edgeGeometry(e) {
    const a = nodeById(e.from.node), b = nodeById(e.to.node);
    if (!a || !b) return null;
    const p1 = anchorPos(a, e.from.side), p2 = anchorPos(b, e.to.side);
    const route = ROUTES.includes(e.route) ? e.route : "curve";

    if (route === "line") {
      return {
        d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`,
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      };
    }
    if (route === "ortho" || route === "diag") {
      const pts = route === "ortho"
        ? orthoPoints(p1, e.from.side, p2, e.to.side)
        : diagPoints(p1, e.from.side, p2, e.to.side);
      return { d: ptsToPath(pts), mid: polyMid(pts) };
    }

    const dx = Math.abs(p2.x - p1.x), dy = Math.abs(p2.y - p1.y);
    const horiz = e.from.side === "left" || e.from.side === "right";
    const h = Math.max(40, (horiz ? dx : dy) * 0.5);
    const c1 = ctrlPoint(p1, e.from.side, h), c2 = ctrlPoint(p2, e.to.side, h);
    return {
      d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
      mid: {
        x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
        y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
      },
    };
  }

  /* ---------- 保存：revision 机制，保存期间的新改动不会被误标已保存 ---------- */
  let rev = 0, savedRev = 0, saving = false, saveAgain = false, saveTimer = null;
  let saveChain = Promise.resolve();
  let saveFailed = false;

  function setStatus(text, cls = "") {
    const el = $("#board-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "board-status " + cls;
  }

  function markDirty() {
    rev++;
    saveFailed = false;
    setStatus("未保存");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), 900);
  }

  async function save(force = false) {
    if (board.id == null) return;
    if (!force && rev === savedRev) return;
    if (saving) { saveAgain = true; return saveChain; }
    const snapshot = rev;
    const boardId = board.id;
    const payload = JSON.stringify({ items: board.items, edges: board.edges });
    saving = true;
    setStatus("保存中…");
    saveChain = (async () => {
      try {
        const r = await fetch(`/api/boards/${boardId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        if (!r.ok) throw new Error(`${r.status}`);
        savedRev = Math.max(savedRev, snapshot);
        saveFailed = false;
        setStatus("已保存", "ok");
      } catch (e) {
        saveFailed = true;
        setStatus("保存失败", "err");
        toast("保存失败：" + (e && e.message ? e.message : e));
      }
    })();
    await saveChain;
    saving = false;
    if (saveAgain || rev !== savedRev) {
      saveAgain = false;
      if (!saveFailed) await save();
    }
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    if (board.id == null) return;
    for (let i = 0; i < 8; i++) {
      if (saving) { await saveChain; continue; }
      if (rev === savedRev || saveFailed) return;
      await save(true);
    }
  }

  /* ---------- 选中 ---------- */
  function syncSelection() {
    canvas.querySelectorAll(".b-item").forEach((el) =>
      el.classList.toggle("selected", selection.nodes.has(el.dataset.node)));
    canvas.querySelectorAll("g[data-edge]").forEach((g) =>
      g.classList.toggle("selected", selection.edges.has(g.dataset.edge)));
    updateSelToolbar();
  }

  function clearSelection() {
    if (!selection.nodes.size && !selection.edges.size) return;
    selection = { nodes: new Set(), edges: new Set() };
    const pop = $("#style-pop");
    if (pop) pop.hidden = true;
    syncSelection();
  }

  function selectNode(id, additive = false) {
    if (additive) {
      selection.nodes.has(id) ? selection.nodes.delete(id) : selection.nodes.add(id);
    } else {
      selection = { nodes: new Set([id]), edges: new Set() };
    }
    syncSelection();
  }

  function selectEdge(id) {
    selection = { nodes: new Set(), edges: new Set([id]) };
    syncSelection();
  }

  function selectAll() {
    selection = {
      nodes: new Set(board.items.map((n) => n.id)),
      edges: new Set(board.edges.map((e) => e.id)),
    };
    syncSelection();
  }

  function selectionBBox() {
    let box = null;
    for (const id of selection.nodes) {
      const n = nodeById(id);
      if (!n) continue;
      box = box
        ? { x: Math.min(box.x, n.x), y: Math.min(box.y, n.y),
            x2: Math.max(box.x2, n.x + n.w), y2: Math.max(box.y2, n.y + n.h) }
        : { x: n.x, y: n.y, x2: n.x + n.w, y2: n.y + n.h };
    }
    if (!box) {
      for (const id of selection.edges) {
        const e = edgeById(id);
        const geo = e && edgeGeometry(e);
        if (!geo) continue;
        box = box
          ? { x: Math.min(box.x, geo.mid.x), y: Math.min(box.y, geo.mid.y),
              x2: Math.max(box.x2, geo.mid.x), y2: Math.max(box.y2, geo.mid.y) }
          : { x: geo.mid.x, y: geo.mid.y, x2: geo.mid.x, y2: geo.mid.y };
      }
    }
    return box;
  }

  function updateSelToolbar() {
    const bar = $("#sel-toolbar");
    const total = selection.nodes.size + selection.edges.size;
    bar.hidden = total === 0;
    $("#sel-label").hidden = selection.edges.size === 0;
    if (!total) {
      $("#style-pop").hidden = true;
      updateSelOutline();
      return;
    }
    const box = selectionBBox();
    if (!box) { bar.hidden = true; return; }
    const r = wrap.getBoundingClientRect();
    let left = board.panX + box.x * board.scale;
    let top = board.panY + box.y * board.scale - 44;
    if (top < 6) top = board.panY + box.y2 * board.scale + 10;
    bar.style.left = clamp(left, 6, Math.max(6, r.width - 260)) + "px";
    bar.style.top = clamp(top, 6, Math.max(6, r.height - 40)) + "px";
    if (!$("#style-pop").hidden) positionStylePop();
    updateStyleControls();
    updateSelOutline();
  }

  /* 选中轮廓覆盖层：画在最上层（组在成员节点下面，轮廓必须盖住它们才看得清） */
  function updateSelOutline() {
    let ol = canvas.querySelector(":scope > .sel-outline");
    if (!selection.nodes.size) { ol?.remove(); return; }
    const box = selectionBBox();
    if (!box) { ol?.remove(); return; }
    if (!ol) {
      ol = document.createElement("div");
      ol.className = "sel-outline";
      canvas.appendChild(ol);
    }
    // 保证覆盖层是最后一个子元素（SVG 边层之后），永远在最上
    canvas.appendChild(ol);
    ol.style.left = box.x + "px";
    ol.style.top = box.y + "px";
    ol.style.width = (box.x2 - box.x) + "px";
    ol.style.height = (box.y2 - box.y) + "px";
    ol.style.borderColor = "var(--accent)";
  }

  function positionStylePop() {
    const pop = $("#style-pop");
    const bar = $("#sel-toolbar");
    if (!pop || pop.hidden || bar.hidden) return;
    const wrapH = wrap.clientHeight;
    const left = clamp(parseFloat(bar.style.left) || 0, 6,
      Math.max(6, wrap.clientWidth - pop.offsetWidth - 8));
    let top = (parseFloat(bar.style.top) || 0) + bar.offsetHeight + 6;
    if (top + pop.offsetHeight > wrapH - 8) {
      top = Math.max(6, (parseFloat(bar.style.top) || 0) - pop.offsetHeight - 6);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  /* ---------- 节点渲染 ---------- */
  /* 内容可以在画布/侧栏里直接改的类型：右下缺角画黑；图片这类只读的画黄 */
  const EDITABLE_TYPES = new Set(["text", "md", "link", "group"]);

  function nodeClass(it) {
    const cls = ["b-item", "b-" + (it.type || "image")];
    if (it.color) cls.push("c" + it.color);
    if (it.color && COLOR_HEX[it.color]) cls.push("tinted");
    if (selection.nodes.has(it.id)) cls.push("selected");
    if (it.type === "image" && !it.fileId) cls.push("missing");
    if (it.type === "comfy" && it.muted) cls.push("muted");
    if (!EDITABLE_TYPES.has(it.type)) cls.push("no-edit");
    if (it.pin) cls.push("pinned");
    return cls.join(" ");
  }

function comfyNodeHTML(it) {
    const rows = (it.widgets || []).map((w) => {
      const k = w.k ? `<span>${esc(w.k)}</span>` : "";
      return `<div class="b-w">${k}<b>${esc(w.v)}</b></div>`;
    }).join("");
    const cls = it.cls && it.cls !== it.title ? `<i>${esc(it.cls)}</i>` : "";
    const muted = it.muted ? '<em>静音</em>' : "";
    return `<div class="b-comfy-head"><span>${esc(it.title || "Node")}</span>${cls}${muted}</div>` +
      (rows ? `<div class="b-comfy-body">${rows}</div>` : "");
  }

  function buildNodeEl(it) {
    const el = document.createElement("div");
    el.className = nodeClass(it);
    el.dataset.node = it.id;
    el.style.cssText = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px`;

    if (it.type === "text") {
      const body = document.createElement("div");
      body.className = "b-text-body";
      body.textContent = it.text || "";
      el.appendChild(body);
    } else if (it.type === "md") {
      const body = document.createElement("div");
      body.className = "b-md-body";
      body.innerHTML = mdToHTML(it.text);
      el.appendChild(body);
      el.insertAdjacentHTML("beforeend", '<span class="md-badge">MD</span>');
    } else if (it.type === "comfy") {
      el.innerHTML = comfyNodeHTML(it);
    } else if (it.type === "link") {
      el.innerHTML = `<div class="b-link"><span>↗</span><span>${esc(it.url || "")}</span></div>`;
    } else if (it.type === "group") {
      el.innerHTML = `<div class="b-group-label">${esc(it.label || "分组")}</div>`;
    } else if (!it.fileId) {
      el.innerHTML = `<div class="b-missing">图片缺失<br><span>${esc(baseName(it.path || it.src || ""))}</span></div>`;
    } else {
      const img = document.createElement("img");
      img.draggable = false;
      img.alt = "";
      img.src = `/api/thumb/${encodeURIComponent(it.fileId)}`;
      img.addEventListener("error", () => {
        if (!img.isConnected) return;
        const ph = document.createElement("div");
        ph.className = "b-missing";
        ph.innerHTML = `图片失效<br><span>${esc(it.fileId)}</span>`;
        el.insertBefore(ph, el.firstChild);
        img.remove();
        el.classList.add("missing");
      });
      el.appendChild(img);
    }

    // 八向透明热区：四条边覆盖完整外轮廓，角区只负责斜向缩放，不画方块。
    for (const d of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      el.insertAdjacentHTML("beforeend", `<div class="rz rz-${d}" data-dir="${d}" aria-hidden="true"></div>`);
    }
    for (const side of SIDES) {
      const dot = document.createElement("div");
      dot.className = `anchor a-${side}`;
      dot.dataset.side = side;
      el.appendChild(dot);
    }
    // 右下缺角：墨色＝内容可编辑，黄色＝只读；固定后黄角里带图钉
    el.insertAdjacentHTML("beforeend",
      `<i class="b-cut" aria-hidden="true"><svg viewBox="0 0 12 12">
        <path d="M7.4 1.4 10.6 4.6M8.6 2.6 5.4 5.8 3.6 6.2 2.2 9.8 5.8 8.4 6.2 6.6 9.4 3.4"
          fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      </svg></i>`);
    applyNodeTextStyle(it, el);
    bindNode(el, it);
    return el;
  }

  function buildEdgeEl(e) {
    const geo = edgeGeometry(e);
    if (!geo) return null;
    const g = document.createElementNS(svgNS, "g");
    g.dataset.edge = e.id;
    if (e.color) g.classList.add("ec" + e.color);
    if (selection.edges.has(e.id)) g.classList.add("selected");
    const suffix = COLOR_HEX[e.color] ? String(e.color) : "d";
    const hit = document.createElementNS(svgNS, "path");
    hit.setAttribute("class", "edge-hit");
    hit.setAttribute("d", geo.d);
    const vis = document.createElementNS(svgNS, "path");
    vis.setAttribute("class", "edge-line");
    vis.setAttribute("d", geo.d);
    if (e.toEnd === "arrow") vis.setAttribute("marker-end", `url(#ea-${suffix})`);
    if (e.fromEnd === "arrow") vis.setAttribute("marker-start", `url(#eas-${suffix})`);
    g.appendChild(hit);
    g.appendChild(vis);
    if (e.label) {
      const t = document.createElementNS(svgNS, "text");
      t.setAttribute("class", "edge-label");
      t.setAttribute("x", geo.mid.x);
      t.setAttribute("y", geo.mid.y);
      t.textContent = e.label;
      g.appendChild(t);
    }
    g.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
        selection.edges.has(e.id) ? selection.edges.delete(e.id) : selection.edges.add(e.id);
        syncSelection();
      } else {
        selectEdge(e.id);
      }
    });
    g.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      editEdge(e);
    });
    g.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!selection.edges.has(e.id)) selectEdge(e.id);
      openEdgeMenu(ev, e);
    });
    return g;
  }

  function redrawEdges() {
    canvas.querySelectorAll("g[data-edge]").forEach((g) => {
      const e = edgeById(g.dataset.edge);
      const geo = e && edgeGeometry(e);
      if (!geo) return;
      g.querySelectorAll("path").forEach((p) => p.setAttribute("d", geo.d));
      const label = g.querySelector(".edge-label");
      if (label) { label.setAttribute("x", geo.mid.x); label.setAttribute("y", geo.mid.y); }
    });
  }

  function render() {
    if (editingCommit) stopTextEdit();   // 重建 DOM 前先提交正在编辑的文本
    hov = null;                          // 旧 DOM 已作废，悬停状态一起清掉
    canvas.innerHTML = "";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "edge-layer");
    let defs = "<defs>";
    for (const suffix of ["d", ...Object.keys(COLOR_HEX)]) {
      const fill = COLOR_HEX[suffix] || EDGE_STROKE;
      defs += `<marker id="ea-${suffix}" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="${fill}"></path></marker>
      <marker id="eas-${suffix}" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="${fill}"></path></marker>`;
    }
    defs += "</defs>";
    svg.innerHTML = defs;
    for (const e of board.edges) {
      const g = buildEdgeEl(e);
      if (g) svg.appendChild(g);
    }
    canvas.appendChild(svg);
    // 组永远先渲染，作为背景容器；普通节点后渲染，保证组内节点可选中。
    const groups = board.items.filter((n) => n.type === "group");
    const normal = board.items.filter((n) => n.type !== "group");
    for (const it of groups) canvas.appendChild(buildNodeEl(it));
    for (const it of normal) canvas.appendChild(buildNodeEl(it));
    applyTransform();
    updateSelToolbar();
    applyImgSrc();
  }

  /* ---------- 节点交互 ---------- */
  function updateNodeFromInspector(it, value) {
    if (it.type === "group") {
      it.label = value;
      const el = nodeEl(it.id);
      const label = el?.querySelector(".b-group-label");
      if (label) label.textContent = value;
    } else if (it.type === "link") {
      it.url = value;
      const el = nodeEl(it.id);
      const link = el?.querySelector(".b-link > span:last-child");
      if (link) link.textContent = value;
    } else if (it.type === "md") {
      it.text = value;
      const body = nodeEl(it.id)?.querySelector(".b-md-body");
      if (body) body.innerHTML = mdToHTML(value);
    } else {
      it.text = value;
      const body = nodeEl(it.id)?.querySelector(".b-text-body");
      if (body) body.textContent = value;
    }
    if (selection.nodes.has(it.id)) window.setInspectorName?.(nodeTitle(it));
    markDirty();
  }

  function previewNode(it) {
    if (!it) return;
    if (it.type === "image" && it.fileId) {
      if (typeof selectImage === "function") selectImage(it.fileId);
      if (typeof setInspector === "function") setInspector(true);
      return;
    }
    if (typeof window.showBoardNodeInspector !== "function") return;
    window.showBoardNodeInspector(it, {
      onChange: (value) => updateNodeFromInspector(it, value),
      onDelete: () => {
        removeNodes([it.id]);
        board.edges = board.edges.filter((e) => e.from.node !== it.id && e.to.node !== it.id);
        selection = { nodes: new Set(), edges: new Set() };
        markDirty();
        render();
        window.hideBoardNodeInspector?.();
        const empty = $("#insp-empty");
        if (empty) { empty.hidden = false; empty.textContent = "点画布上的图片、文字或 Markdown 节点，这里显示内容与参数。"; }
      },
      onDuplicate: () => {
        selection = { nodes: new Set([it.id]), edges: new Set() };
        syncSelection();
        duplicateSelection();
      },
    });
  }

  function bindNode(el, it) {
    el.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (spaceDown) return;                 // 空格按住时交给画布平移
      if (editingText === it.id) {
        // 点在编辑框里：交给浏览器放光标；点在框外：结束编辑再照常处理
        if (ev.target.closest(".b-text-body, .b-md-body")) return;
        stopTextEdit();
      }
      if (ev.target.classList.contains("anchor")) {
        startLink(ev, it, ev.target.dataset.side);
        return;
      }
      // 缺角就是「固定」开关：把手没弹出时才可点，弹出后那个位置让给缩放把手
      if (ev.target.closest(".b-cut") && !el.classList.contains("handles")) {
        ev.stopPropagation();
        ev.preventDefault();
        if (!selection.nodes.has(it.id)) selectNode(it.id);
        togglePin([it.id]);
        return;
      }
      ev.stopPropagation();
      const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
      if (additive) {
        selectNode(it.id, true);
        previewNode(it);
        return;
      }
      if (!selection.nodes.has(it.id)) selectNode(it.id);
      previewNode(it);
      if (ev.target.classList.contains("rz")) {
        // 单选才缩放；多选/无独占选中时抓到把手不吞事件，照常整组移动
        if (selection.nodes.size === 1) startResize(ev, it, el, ev.target.dataset.dir || "se");
        else startMove(ev);
        return;
      }
      startMove(ev);
    });

    el.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      // 双击即选中并同步右侧介绍栏，避免"在改 A、侧栏还是 B"
      if (!selection.nodes.has(it.id)) {
        selectNode(it.id);
        previewNode(it);
      }
      if (it.type === "text" || it.type === "md") startTextEdit(it, el);
      else if (it.type === "image" && it.fileId) openLightbox(it.fileId);
      else if (it.type === "link" && it.url) window.open(it.url, "_blank");
      else if (it.type === "group") previewNode(it);
    });

    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!selection.nodes.has(it.id)) selectNode(it.id);
      previewNode(it);
      openNodeMenu(ev, it);
    });
  }

  /* 组是容器：拖组时，中心点落在组里的节点一并移动（含嵌套组，递归展开）。 */
  function withGroupMembers(ids) {
    const out = new Set(ids);
    let grew = true;
    while (grew) {
      grew = false;
      for (const gid of [...out]) {
        const g = nodeById(gid);
        if (!g || g.type !== "group") continue;
        for (const n of board.items) {
          if (out.has(n.id)) continue;
          const cx = n.x + n.w / 2;
          const cy = n.y + n.h / 2;
          if (cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h) {
            out.add(n.id);
            grew = true;
          }
        }
      }
    }
    return out;
  }

  /* ---------- 悬停边框 0.5 秒：强调当前边的菱形锚点（透明缩放热区常驻） ---------- */
  const HANDLE_BAND = 22;     // 距边框多少 px 算「在边上」
  const HANDLE_DELAY = 500;   // 停留多久才弹出来
  let hov = null;             // { id, el, arm, hide }
  /* 正在拖拽（移动/改大小/拉线/平移/框选）时，悬停逻辑一律不插手，
     否则指针离开节点就会把刚弹出的把手收掉，拖到一半目标没了。 */
  let dragging = false;
  document.addEventListener("mouseup", () => { dragging = false; }, true);

  function hoverSide(rect, cx, cy) {
    const list = [
      { s: "top", d: cy - rect.top },
      { s: "bottom", d: rect.bottom - cy },
      { s: "left", d: cx - rect.left },
      { s: "right", d: rect.right - cx },
    ].sort((a, b) => a.d - b.d);
    return list[0].d <= HANDLE_BAND ? list[0].s : "";
  }

  function dropHover() {
    if (!hov) return;
    clearTimeout(hov.arm);
    clearTimeout(hov.hide);
    hov.el.classList.remove("handles");
    hov = null;
  }

  function onHoverMove(ev) {
    if (spaceDown || dragging) return;            // 拖动/平移时不插手
    const el = ev.target?.closest?.(".b-item");
    if (!el) { dropHover(); return; }
    const id = el.dataset.node;
    if (!hov || hov.id !== id) {
      dropHover();
      hov = { id, el, arm: 0, hide: 0 };
    }
    const side = hoverSide(el.getBoundingClientRect(), ev.clientX, ev.clientY);
    if (side) {
      el.dataset.hs = side;
      clearTimeout(hov.hide); hov.hide = 0;
      if (!el.classList.contains("handles") && !hov.arm) {
        hov.arm = setTimeout(() => {
          hov.arm = 0;
          el.classList.add("handles");
        }, HANDLE_DELAY);
      }
      return;
    }
    // 指针进到节点内部：已经弹出的把手先留着，别一闪一闪
    if (!el.classList.contains("handles")) {
      clearTimeout(hov.arm);
      hov.arm = 0;
    }
  }

  wrap.addEventListener("mousemove", onHoverMove);
  wrap.addEventListener("mouseleave", dropHover);

  /* ---------- 固定：钉住的节点不能被拖动/改大小 ---------- */
  function togglePin(ids) {
    const list = ids && ids.length ? ids : [...selection.nodes];
    if (!list.length) return;
    const target = list.map(nodeById).filter(Boolean);
    const pin = !target.every((n) => n.pin);   // 有一个没固定就全部固定
    for (const n of target) {
      if (pin) n.pin = true;
      else delete n.pin;
    }
    for (const n of target) nodeEl(n.id)?.classList.toggle("pinned", !!n.pin);
    markDirty();
    toast(pin ? "已固定：位置与大小锁定" : "已取消固定");
  }

  function startMove(ev) {
    dragging = true;
    const drag = [];
    const moving = withGroupMembers(selection.nodes);
    for (const id of moving) {
      const n = nodeById(id);
      if (n && n.pin) continue;                  // 固定住的节点不跟着拖
      const el = nodeEl(id);
      if (n && el) drag.push({ n, el, ox: n.x, oy: n.y });
    }
    if (!drag.length) return;
    const sx = ev.clientX, sy = ev.clientY;
    let moved = false;
    const onMove = (e) => {
      const dx = (e.clientX - sx) / board.scale;
      const dy = (e.clientY - sy) / board.scale;
      if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 2) return;
      moved = true;
      for (const d of drag) {
        d.n.x = Math.round(d.ox + dx);
        d.n.y = Math.round(d.oy + dy);
        d.el.style.left = d.n.x + "px";
        d.el.style.top = d.n.y + "px";
      }
      redrawEdges();
      updateSelToolbar();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (moved) markDirty();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    ev.preventDefault();
  }

  function startResize(ev, it, el, dir) {
    if (it.pin) { toast("节点已固定，先取消固定再改大小"); return; }
    dragging = true;
    const sx = ev.clientX, sy = ev.clientY;
    const o = { x: it.x, y: it.y, w: it.w, h: it.h };
    // 默认完全自由（宽高各改各的），按住 Shift 才锁原始比例
    const keepRatio = !!(ev.shiftKey || ev.ctrlKey);
    const ratio = o.h / Math.max(1, o.w);
    const has = (c) => dir.includes(c);
    let resized = false;
    const onMove = (e) => {
      const dx = (e.clientX - sx) / board.scale;
      const dy = (e.clientY - sy) / board.scale;
      let x = o.x, y = o.y, w = o.w, h = o.h;
      if (has("e")) w = o.w + dx;
      if (has("w")) { w = o.w - dx; x = o.x + dx; }
      if (has("s")) h = o.h + dy;
      if (has("n")) { h = o.h - dy; y = o.y + dy; }
      if (keepRatio) {
        if (!has("e") && !has("w")) {          // 纯上下边：以高驱动
          h = Math.max(MIN_H, h);
          w = Math.max(MIN_W, Math.round(h / ratio));
        } else {                                // 有横向分量：以宽驱动
          w = Math.max(MIN_W, w);
          h = Math.max(MIN_H, Math.round(w * ratio));
          if (has("n")) y = o.y + (o.h - h);
        }
        if (has("w")) x = o.x + (o.w - w);
      }
      it.x = Math.round(x); it.y = Math.round(y);
      it.w = Math.max(MIN_W, Math.round(w)); it.h = Math.max(MIN_H, Math.round(h));
      el.style.left = it.x + "px";
      el.style.top = it.y + "px";
      el.style.width = it.w + "px";
      el.style.height = it.h + "px";
      resized = true;
      redrawEdges();
      updateSelToolbar(); updateSelOutline();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (resized) { markDirty(); applyImgSrc(); }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    ev.preventDefault();
    ev.stopPropagation();
  }

  /* ---------- 文本编辑 ---------- */
  /* 编辑状态的提交函数。放在外面，好让"点到框外""重新渲染"都能主动收尾，
     不会因为 blur 没触发而把节点卡在编辑态（那样就再也拖不动了）。 */
  let editingCommit = null;

  function stopTextEdit() {
    const fn = editingCommit;
    editingCommit = null;
    editingText = null;
    if (fn) { try { fn(); } catch { /* 提交失败也不阻塞 */ } }
  }

  function startTextEdit(it, el) {
    // 文本节点改纯文本；Markdown 节点在画布上直接改源码，失焦后重新渲染
    const isMd = it.type === "md";
    const body = el.querySelector(isMd ? ".b-md-body" : ".b-text-body");
    if (!body) return;
    if (editingText === it.id) return;
    if (editingCommit) stopTextEdit();
    editingText = it.id;
    el.classList.add("editing");
    body.classList.add("editing");
    if (isMd) {
      body.textContent = it.text || "";
      body.classList.add("md-raw");
    }
    body.contentEditable = "true";
    body.focus();
    try { document.getSelection().selectAllChildren(body); } catch { /* ignore */ }

    const done = () => {
      if (editingCommit !== done) return;
      editingCommit = null;
      editingText = null;
      body.contentEditable = "false";
      body.classList.remove("editing");
      el.classList.remove("editing");
      it.text = body.innerText.replace(/\n$/, "");
      if (isMd) {
        body.classList.remove("md-raw");
        body.innerHTML = mdToHTML(it.text);
      }
      markDirty();
      if (selection.nodes.has(it.id)) previewNode(it);
    };
    editingCommit = done;

    body.addEventListener("blur", done, { once: true });
    body.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { ev.preventDefault(); body.blur(); }
    });
    // 尺寸由用户拖动外轮廓决定：内容超出时框内滚动，不再自动长高
    body.addEventListener("input", () => { markDirty(); });
  }

  /* ---------- 连线 ---------- */
  function clearLinkTargets() {
    canvas.querySelectorAll(".link-target").forEach((el) => el.classList.remove("link-target"));
  }

  /* 优先命中真实菱形，而不是只按两个节点的相对位置猜连接方向。 */
  function hitAnchor(cx, cy) {
    const anchors = [...canvas.querySelectorAll(".b-item .anchor")].reverse();
    for (const anchor of anchors) {
      const r = anchor.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        const el = anchor.closest(".b-item");
        return { id: el.dataset.node, side: anchor.dataset.side, el, anchor };
      }
    }
    return null;
  }

  /* 拖到节点主体时仍允许连线：终点取离释放位置最近的那条边。 */
  function nearestNodeSide(n, p) {
    return [
      { side: "top", d: Math.abs(p.y - n.y) },
      { side: "right", d: Math.abs(p.x - n.x - n.w) },
      { side: "bottom", d: Math.abs(p.y - n.y - n.h) },
      { side: "left", d: Math.abs(p.x - n.x) },
    ].sort((a, b) => a.d - b.d)[0].side;
  }

  function startLink(ev, fromNode, fromSide) {
    dragging = true;
    ev.stopPropagation();
    ev.preventDefault();
    const svg = scene();
    if (!svg) return;
    const temp = document.createElementNS(svgNS, "path");
    temp.setAttribute("class", "edge-line temp");
    svg.appendChild(temp);
    const p0 = anchorPos(fromNode, fromSide);
    const onMove = (e) => {
      const p = toWorld(e.clientX, e.clientY);
      temp.setAttribute("d", `M ${p0.x} ${p0.y} L ${p.x} ${p.y}`);
      clearLinkTargets();
      const hit = hitAnchor(e.clientX, e.clientY) || hitNode(e.clientX, e.clientY);
      if (hit && hit.id !== fromNode.id) {
        hit.el.classList.add("link-target");
        hit.anchor?.classList.add("link-target");
      }
    };
    const onUp = (e) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      temp.remove();
      clearLinkTargets();
      const anchor = hitAnchor(e.clientX, e.clientY);
      const hit = anchor || hitNode(e.clientX, e.clientY);
      if (!hit || hit.id === fromNode.id) return;
      const toNode = nodeById(hit.id);
      if (!toNode) return;
      board.edges.push({
        id: uid("e"),
        // 起点必须保留用户抓取的菱形，不能再按节点方位改回右侧。
        from: { node: fromNode.id, side: fromSide },
        to: { node: toNode.id, side: anchor ? anchor.side : nearestNodeSide(toNode, toWorld(e.clientX, e.clientY)) },
      });
      markDirty();
      render();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function hitNode(cx, cy) {
    const els = [...canvas.querySelectorAll(".b-item")].reverse();
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        return { id: el.dataset.node, el };
      }
    }
    return null;
  }

  async function editEdge(e) {
    const label = await appPrompt("连线标签（留空＝取消修改，可在右键菜单清除）：", e.label || "");
    if (!label) return;
    e.label = String(label).trim();
    if (!e.label) delete e.label;
    markDirty();
    render();
  }

  /* ---------- 删除 / 复制 / 层级 ---------- */
  function removeNodes(ids) {
    const set = new Set(ids);
    board.items = board.items.filter((n) => !set.has(n.id));
    board.edges = board.edges.filter((e) => !set.has(e.from.node) && !set.has(e.to.node));
    for (const id of set) selection.nodes.delete(id);
    const alive = new Set(board.edges.map((e) => e.id));
    selection.edges = new Set([...selection.edges].filter((id) => alive.has(id)));
  }

  function deleteSelection() {
    if (!selection.nodes.size && !selection.edges.size) return false;
    const nodeIds = [...selection.nodes];
    const edgeIds = new Set(selection.edges);
    removeNodes(nodeIds);
    board.edges = board.edges.filter((e) => !edgeIds.has(e.id));
    selection = { nodes: new Set(), edges: new Set() };
    markDirty();
    render();
    return true;
  }

  function cloneSelection() {
    const nodes = [];
    const idMap = new Map();
    for (const id of selection.nodes) {
      const n = nodeById(id);
      if (!n) continue;
      const copy = JSON.parse(JSON.stringify(n));
      copy.id = uid(n.type === "text" ? "t" : "n");
      idMap.set(id, copy.id);
      nodes.push(copy);
    }
    const edges = [];
    for (const e of board.edges) {
      if (!idMap.has(e.from.node) || !idMap.has(e.to.node)) continue;
      edges.push({
        ...JSON.parse(JSON.stringify(e)),
        id: uid("e"),
        from: { node: idMap.get(e.from.node), side: e.from.side },
        to: { node: idMap.get(e.to.node), side: e.to.side },
      });
    }
    return { nodes, edges };
  }

  function pastePayload(payload, dx = 26, dy = 26) {
    if (!payload || !payload.nodes.length) return;
    const idMap = new Map();
    const nodes = payload.nodes.map((n) => {
      const copy = JSON.parse(JSON.stringify(n));
      copy.id = uid(copy.type === "text" ? "t" : "n");
      copy.x += dx;
      copy.y += dy;
      delete copy.pin;              // 复制出来的节点不继承「固定」，否则一放下就拖不动
      idMap.set(n.id, copy.id);
      return copy;
    });
    const edges = payload.edges.map((e) => ({
      ...JSON.parse(JSON.stringify(e)),
      id: uid("e"),
      from: { node: idMap.get(e.from.node), side: e.from.side },
      to: { node: idMap.get(e.to.node), side: e.to.side },
    }));
    board.items.push(...nodes);
    board.edges.push(...edges);
    selection = { nodes: new Set(nodes.map((n) => n.id)), edges: new Set() };
    markDirty();
    render();
  }

  function duplicateSelection() {
    if (!selection.nodes.size) return;
    pastePayload(cloneSelection());
  }

  let clipboard = null;
  function copySelection() {
    if (!selection.nodes.size) return;
    clipboard = cloneSelection();
    toast(`已复制 ${clipboard.nodes.length} 个节点`);
  }

  function reorderSelection(front) {
    if (!selection.nodes.size) return;
    const picked = board.items.filter((n) => selection.nodes.has(n.id));
    // 组只能调整组与组之间的前后关系，不能跑到普通节点上方
    const allGroups = picked.every((n) => n.type === "group");
    const groups = board.items.filter((n) => n.type === "group");
    const normal = board.items.filter((n) => n.type !== "group");
    const inPicked = (n) => selection.nodes.has(n.id);
    const domain = allGroups ? groups : normal;
    const pickedInDomain = domain.filter(inPicked);
    const rest = domain.filter((n) => !inPicked(n));
    const ordered = front ? [...rest, ...pickedInDomain] : [...pickedInDomain, ...rest];
    board.items = allGroups ? [...ordered, ...normal] : [...groups, ...ordered];
    markDirty();
    render();
  }

  function nudge(dx, dy) {
    if (!selection.nodes.size) return;
    for (const id of withGroupMembers(selection.nodes)) {
      const n = nodeById(id);
      if (!n || n.pin) continue;
      n.x += dx; n.y += dy;
      const el = nodeEl(id);
      if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
    }
    redrawEdges();
    updateSelToolbar();
    markDirty();
  }

  /* ---------- 颜色 ---------- */
  function setSelectionColor(color) {
    for (const id of selection.nodes) {
      const n = nodeById(id);
      if (!n) continue;
      if (color) n.color = color; else delete n.color;
    }
    for (const id of selection.edges) {
      const e = edgeById(id);
      if (!e) continue;
      if (color) e.color = color; else delete e.color;
    }
    markDirty();
    render();
  }

  function buildColorSwatches() {
    const host = $("#sel-colors");
    host.innerHTML = "";
    for (const [val, name] of COLORS) {
      const b = document.createElement("button");
      b.className = "sw" + (val ? " c" + val : " none");
      b.dataset.color = val;
      b.title = name;
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.addEventListener("click", (ev) => { ev.stopPropagation(); setSelectionColor(val); });
      host.appendChild(b);
    }
  }

  function primarySelectedNode() {
    for (const id of selection.nodes) {
      const n = nodeById(id);
      if (n) return n;
    }
    return null;
  }

  function updateStyleControls() {
    const n = primarySelectedNode();
    if (!n) return;
    const color = $("#style-text-color");
    if (color) color.value = n.textColor || "#161616";
    const size = $("#style-font-size");
    if (size) size.value = n.fontSize ? String(n.fontSize) : "";
    const family = $("#style-font-family");
    if (family) family.value = n.fontFamily || "";
    const line = $("#style-line-height");
    if (line) line.value = n.lineHeight ? String(n.lineHeight) : "";
    document.querySelectorAll("#style-align button").forEach((b) =>
      b.classList.toggle("active", (n.textAlign || "left") === b.dataset.align));
  }

  function setSelectionTextStyle(patch) {
    let changed = false;
    for (const id of selection.nodes) {
      const n = nodeById(id);
      if (!n) continue;
      for (const [key, value] of Object.entries(patch)) {
        if (value === "" || value == null) delete n[key];
        else n[key] = value;
      }
      const el = nodeEl(id);
      if (el) applyNodeTextStyle(n, el);
      changed = true;
    }
    if (!changed) return;
    markDirty();
    updateStyleControls();
  }

  function resetSelectionTextStyle() {
    setSelectionTextStyle({
      textColor: "", fontSize: "", textAlign: "", fontFamily: "", lineHeight: "",
    });
  }

  /* ---------- 框选 / 平移 / 缩放 ---------- */
  wrap.addEventListener("contextmenu", (ev) => {
    if (ev.target.closest("#sel-toolbar") || ev.target.closest("#style-pop") ||
        ev.target.closest("#canvas-dock")) return;
    if (ev.target.closest(".b-item") || ev.target.closest("g[data-edge]")) return;
    ev.preventDefault();
    clearSelection();
    openBlankMenu(ev);
  });

  wrap.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("#sel-toolbar") || ev.target.closest("#style-pop") ||
        ev.target.closest("#canvas-dock")) return;
    if (ev.button === 1 || spaceDown || (ev.button === 0 && ev.altKey)) {
      ev.preventDefault();
      startPan(ev);
      return;
    }
    if (ev.target.closest(".b-item") || ev.target.closest("g[data-edge]")) return;
    if (ev.button !== 0) return;
    startMarquee(ev);
  });

  function startPan(ev) {
    dragging = true;
    const sx = ev.clientX - board.panX, sy = ev.clientY - board.panY;
    wrap.classList.add("panning");
    const onMove = (e) => {
      board.panX = e.clientX - sx;
      board.panY = e.clientY - sy;
      applyTransform();
      updateSelToolbar();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      wrap.classList.remove("panning");
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function startMarquee(ev) {
    dragging = true;
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    const base = additive
      ? { nodes: new Set(selection.nodes), edges: new Set(selection.edges) }
      : { nodes: new Set(), edges: new Set() };
    if (!additive) clearSelection();
    const r = wrap.getBoundingClientRect();
    const x0 = ev.clientX, y0 = ev.clientY;
    const box = document.createElement("div");
    box.className = "marquee";
    wrap.appendChild(box);
    let active = false;
    const onMove = (e) => {
      if (!active && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 4) return;
      active = true;
      const l = Math.min(x0, e.clientX) - r.left;
      const t = Math.min(y0, e.clientY) - r.top;
      box.style.left = l + "px";
      box.style.top = t + "px";
      box.style.width = Math.abs(e.clientX - x0) + "px";
      box.style.height = Math.abs(e.clientY - y0) + "px";
      const a = toWorld(Math.min(x0, e.clientX), Math.min(y0, e.clientY));
      const b = toWorld(Math.max(x0, e.clientX), Math.max(y0, e.clientY));
      const nodes = new Set(base.nodes);
      for (const it of board.items) {
        if (it.x < b.x && it.x + it.w > a.x && it.y < b.y && it.y + it.h > a.y) nodes.add(it.id);
      }
      const edges = new Set(base.edges);
      for (const ed of board.edges) {
        if (nodes.has(ed.from.node) && nodes.has(ed.to.node)) edges.add(ed.id);
      }
      selection = { nodes, edges };
      syncSelection();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      box.remove();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /* 滚轮平滑缩放：rAF 向目标 scale 指数收敛（~100ms），锚点跟随鼠标 */
  let zoomTarget = null, zoomRAF = null, zoomAnchorPt = null;
  function zoomSmoothTo(next, cx, cy) {
    zoomTarget = clamp(next, 0.08, 4);
    zoomAnchorPt = { x: cx, y: cy };
    if (!zoomRAF) zoomRAF = requestAnimationFrame(zoomStep);
  }
  function zoomStep() {
    const diff = zoomTarget - board.scale;
    if (Math.abs(diff) < 0.002) {
      setZoom(zoomTarget, zoomAnchorPt?.x, zoomAnchorPt?.y);
      zoomRAF = null;
      return;
    }
    setZoom(board.scale + diff * 0.25, zoomAnchorPt?.x, zoomAnchorPt?.y);
    zoomRAF = requestAnimationFrame(zoomStep);
  }

  wrap.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey && !ev.deltaY) return;
    zoomSmoothTo(board.scale * (ev.deltaY < 0 ? 1.25 : 1 / 1.25), ev.clientX, ev.clientY);
  }, { passive: false });

  document.addEventListener("keydown", (ev) => {
    if (ev.code === "Space" && !$("#view-board").hidden) {
      const t = document.activeElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      spaceDown = true;
      wrap.classList.add("space");
      ev.preventDefault();
    }
  });
  document.addEventListener("keyup", (ev) => {
    if (ev.code === "Space") {
      spaceDown = false;
      wrap.classList.remove("space");
    }
  });
  window.addEventListener("blur", () => {
    spaceDown = false;
    wrap.classList.remove("space");
  });

  /* ---------- 图片高清切换 ---------- */
  function applyImgSrc() {
    const useFull = (n) => board.scale * n.w > 640;
    canvas.querySelectorAll(".b-item.b-image img").forEach((img) => {
      const n = nodeById(img.closest(".b-item").dataset.node);
      if (!n || !n.fileId) return;
      const want = useFull(n) ? "/api/file/" : "/api/thumb/";
      if (!img.src.includes(want + encodeURIComponent(n.fileId))) {
        img.src = want + encodeURIComponent(n.fileId);
      }
    });
  }

  /* ---------- 右键菜单 ---------- */
  function closeMenu() { $("#ctx-menu").hidden = true; }

  function openMenu(ev, items) {
    const menu = $("#ctx-menu");
    menu.innerHTML = "";
    for (const item of items) {
      if (!item) continue;
      if (item.sep) { menu.insertAdjacentHTML("beforeend", '<div class="ctx-sep"></div>'); continue; }
      const d = document.createElement("div");
      d.className = "ctx-item" + (item.danger ? " danger" : "") + (item.disabled ? " disabled" : "");
      d.textContent = item.label;
      if (!item.disabled) d.onclick = () => { closeMenu(); item.fn(); };
      menu.appendChild(d);
    }
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(ev.clientX, innerWidth - rect.width - 8) + "px";
    menu.style.top = Math.min(ev.clientY, innerHeight - rect.height - 8) + "px";
  }

  function openNodeMenu(ev, it) {
    const items = [];
    if (it.type === "text" || it.type === "md") items.push({ label: "在画布上直接编辑", fn: () => {
      const el = nodeEl(it.id);
      if (el) startTextEdit(it, el);
    } });
    if (it.type === "image" && it.fileId) {
      items.push({ label: "打开大图", fn: () => openLightbox(it.fileId) });
      items.push({ label: "复制文件路径", fn: async () => {
        try {
          const m = await api("/api/meta/" + encodeURIComponent(it.fileId));
          copyText(m.file?.path || "");
        } catch { toast("读取路径失败"); }
      } });
      items.push({ label: "节点图送入画板", fn: () => addGraphToBoard(it.fileId) });
    }
    if (it.type === "comfy") {
      items.push({ label: "复制节点参数", fn: () => {
        const text = [it.title, ...(it.widgets || []).map((w) => `${w.k}: ${w.v}`)].join("\n");
        copyText(text);
        toast("已复制节点参数");
      } });
      items.push({ label: "选中上游节点", fn: () => selectUpstream(it.id) });
    }
    items.push({ label: "复制选中 (Ctrl+D)", fn: duplicateSelection });
    items.push({ sep: true });
    items.push({ label: "置于顶层", fn: () => reorderSelection(true) });
    items.push({ label: "置于底层", fn: () => reorderSelection(false) });
    items.push({ sep: true });
    items.push({
      label: it.pin ? "取消固定" : "固定（锁定位置与大小）",
      fn: () => togglePin(selection.nodes.has(it.id) ? [...selection.nodes] : [it.id]),
    });
    items.push({ sep: true });
    items.push({ label: "删除", danger: true, fn: () => { deleteSelection(); } });
    openMenu(ev, items);
  }

  function openEdgeMenu(ev, e) {
    const cur = ROUTES.includes(e.route) ? e.route : "curve";
    const routeItems = ROUTES.map((r) => ({
      label: (r === cur ? "✓ " : "　") + "走线：" + ROUTE_LABEL[r],
      fn: () => { e.route = r; markDirty(); render(); },
    }));
    openMenu(ev, [
      { label: "编辑标签…", fn: () => editEdge(e) },
      { label: "清除标签", disabled: !e.label, fn: () => { delete e.label; markDirty(); render(); } },
      { sep: true },
      ...routeItems,
      { sep: true },
      { label: "箭头：末端", fn: () => { e.toEnd = "arrow"; delete e.fromEnd; markDirty(); render(); } },
      { label: "箭头：双向", fn: () => { e.toEnd = "arrow"; e.fromEnd = "arrow"; markDirty(); render(); } },
      { label: "无箭头", fn: () => { delete e.toEnd; delete e.fromEnd; markDirty(); render(); } },
      { sep: true },
      { label: "删除连线", danger: true, fn: () => {
        board.edges = board.edges.filter((x) => x.id !== e.id);
        selection.edges.delete(e.id);
        markDirty(); render();
      } },
    ]);
  }

  function openBlankMenu(ev) {
    const world = toWorld(ev.clientX, ev.clientY);
    openMenu(ev, [
      { label: "新建文本节点", fn: () => addTextNode(world) },
      { label: "粘贴", disabled: !clipboard, fn: () => pastePayload(clipboard) },
      { label: "全选", fn: selectAll },
      { sep: true },
      { label: "适应全部节点", fn: fitView },
      { label: "缩放 100%", fn: () => setZoom(1) },
      { sep: true },
      { label: "导入 .canvas…", fn: () => $("#canvas-file").click() },
      { label: "导出 .canvas", fn: () => exportCanvas() },
    ]);
  }

  /* ---------- 建板 / 载入 ---------- */
  async function ensureBoard() {
    if (board.id != null) return board.id;
    const { id } = await api("/api/boards", { method: "POST", body: { name: "未命名画板" } });
    board.id = id;
    board.name = "未命名画板";
    const sel = $("#board-select");
    if (sel.firstChild && sel.firstChild.value === "") sel.firstChild.remove();
    const opt = document.createElement("option");
    opt.value = String(id);
    opt.textContent = board.name;
    sel.appendChild(opt);
    sel.value = String(id);
    syncToolbar();
    toast("已自动创建画板「未命名画板」");
    return id;
  }

  function restoreViewport() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem("texture.view." + board.id) || "null"); } catch { v = null; }
    if (v && Number.isFinite(v.scale)) {
      board.scale = clamp(v.scale, 0.08, 4);
      board.panX = Number(v.panX) || 0;
      board.panY = Number(v.panY) || 0;
      return true;
    }
    return false;
  }

  async function loadBoard(id, opts = {}) {
    if (!opts.skipSave) await flushSave();
    const b = await api("/api/boards/" + id);
    board.id = b.id;
    board.name = b.name;
    board.items = (b.items || []).map(normalizeNode);
    board.edges = (b.edges || []).map(normalizeEdge);
    rev = 0;
    savedRev = 0;
    selection = { nodes: new Set(), edges: new Set() };
    if (!restoreViewport()) {
      board.scale = 1; board.panX = 120; board.panY = 80;
    }
    render();
    if (pendingFit || (!localStorage.getItem("texture.view." + board.id) && board.items.length)) {
      pendingFit = false;
      // 含节点图的画板：以可读比例打开（节点里的参数要看得清），看全貌按 F；
      // 其余画板照常整块适应。
      const hasComfy = board.items.some((n) => n.type === "comfy");
      fitView(hasComfy ? { min: 0.8 } : {});
    }
    setStatus("");
    syncToolbar();
  }

  async function loadBoards(selectId = null) {
    const { boards } = await api("/api/boards");
    const sel = $("#board-select");
    sel.innerHTML = boards.length
      ? boards.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")
      : "<option value=''>（无画板，请新建）</option>";
    if (!boards.length) {
      board.id = null; board.items = []; board.edges = [];
      selection = { nodes: new Set(), edges: new Set() };
      render(); syncToolbar();
      return;
    }
    let target = selectId;
    if (target == null) {
      target = boards.some((b) => b.id === board.id) ? board.id : boards[0].id;
    }
    sel.value = String(target);
    await loadBoard(target, { skipSave: selectId == null });
  }

  function syncToolbar() {
    const has = board.id != null;
    for (const id of ["board-save", "board-export", "board-export-canvas",
                      "board-export-canvas-vault", "board-delete", "board-rename"]) {
      const el = $("#" + id);
      if (el) el.disabled = !has;
    }
  }

  /* ---------- 添加节点 ---------- */
  function addTextNode(world, text = "双击编辑文字") {
    const c = world || toWorld(
      wrap.getBoundingClientRect().left + wrap.clientWidth / 2,
      wrap.getBoundingClientRect().top + wrap.clientHeight / 2);
    const it = {
      id: uid("t"), type: "text", text,
      x: Math.round(c.x - 120), y: Math.round(c.y - 80), w: 240, h: 160,
    };
    board.items.push(it);
    selection = { nodes: new Set([it.id]), edges: new Set() };
    markDirty();
    render();
    const el = nodeEl(it.id);
    if (el) startTextEdit(it, el);
    previewNode(it);
  }

  function addMarkdownNode(world, text = "# 新文档\n\n在这里写 Markdown。\n\n- 支持标题\n- 支持列表\n- 支持 `行内代码` 和 **粗体**") {
    const c = world || toWorld(
      wrap.getBoundingClientRect().left + wrap.clientWidth / 2,
      wrap.getBoundingClientRect().top + wrap.clientHeight / 2);
    const it = {
      id: uid("m"), type: "md", text,
      x: Math.round(c.x - 160), y: Math.round(c.y - 110), w: 320, h: 220,
    };
    board.items.push(it);
    selection = { nodes: new Set([it.id]), edges: new Set() };
    markDirty();
    render();
    previewNode(it);
    setTimeout(() => $("#insp-node-text")?.focus(), 40);
  }

  function addLinkNode(world, url = "https://") {
    const c = world || toWorld(
      wrap.getBoundingClientRect().left + wrap.clientWidth / 2,
      wrap.getBoundingClientRect().top + wrap.clientHeight / 2);
    const it = {
      id: uid("l"), type: "link", url,
      x: Math.round(c.x - 130), y: Math.round(c.y - 40), w: 260, h: 80,
    };
    board.items.push(it);
    selection = { nodes: new Set([it.id]), edges: new Set() };
    markDirty();
    render();
    previewNode(it);
    setTimeout(() => {
      const input = $("#insp-node-text");
      if (input) { input.focus(); input.select(); }
    }, 40);
  }

  function addGroupNode(world) {
    let box = null;
    for (const id of selection.nodes) {
      const n = nodeById(id);
      if (!n || n.type === "group") continue;
      box = box
        ? { x: Math.min(box.x, n.x), y: Math.min(box.y, n.y),
            x2: Math.max(box.x2, n.x + n.w), y2: Math.max(box.y2, n.y + n.h) }
        : { x: n.x, y: n.y, x2: n.x + n.w, y2: n.y + n.h };
    }
    let it;
    if (box) {
      const padX = 36, top = 46, bottom = 32;
      it = normalizeNode({
        id: uid("g"), type: "group",
        label: `分组 ${board.items.filter((n) => n.type === "group").length + 1}`,
        x: Math.round(box.x - padX), y: Math.round(box.y - top),
        w: Math.round(box.x2 - box.x + padX * 2),
        h: Math.round(box.y2 - box.y + top + bottom),
      });
    } else {
      const c = world || toWorld(
        wrap.getBoundingClientRect().left + wrap.clientWidth / 2,
        wrap.getBoundingClientRect().top + wrap.clientHeight / 2);
      it = normalizeNode({
        id: uid("g"), type: "group", label: "新分组",
        x: Math.round(c.x - 220), y: Math.round(c.y - 150), w: 440, h: 300,
      });
    }
    // 组加入数组最前；render 还会强制组先画，双重保证它在成员节点下方
    board.items.unshift(it);
    selection = { nodes: new Set([it.id]), edges: new Set() };
    markDirty();
    render();
    previewNode(it);
    toast(box ? "已用选中节点创建分组" : "已创建空分组，可拖入图片或文字");
  }

  $("#board-add-text")?.addEventListener("click", async () => {
    await ensureBoard();
    addTextNode(null);
  });

  document.querySelectorAll("#canvas-dock button[data-add]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try { await ensureBoard(); }
      catch (e) { toast("创建画板失败：" + (e && e.message ? e.message : e)); return; }
      const kind = btn.dataset.add;
      if (kind === "text") addTextNode(null);
      else if (kind === "md") addMarkdownNode(null);
      else if (kind === "group") addGroupNode(null);
      else if (kind === "link") {
        const url = await appPrompt("链接地址：", "https://");
        if (!url) return;
        addLinkNode(null, url.trim());
      }
    });
  });

  /* ---------- 拖放图片上板（同一张图可重复放入） ---------- */
  const dimCache = new Map();
  wrap.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  });
  wrap.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    const fileId = ev.dataTransfer.getData("text/texture-id");
    if (!fileId) return;
    try {
      await ensureBoard();
    } catch (e) { toast("创建画板失败：" + (e && e.message ? e.message : e)); return; }
    if (!dimCache.has(fileId)) {
      try {
        const m = await api("/api/meta/" + encodeURIComponent(fileId));
        dimCache.set(fileId, { w: m.pxw || 0, h: m.pxh || 0 });
      } catch { dimCache.set(fileId, { w: 0, h: 0 }); }
    }
    const dim = dimCache.get(fileId);
    const ratio = dim.w > 0 ? dim.h / dim.w : 1;
    const pos = toWorld(ev.clientX, ev.clientY);
    const w = 220;
    const h = Math.min(520, Math.max(120, Math.round(w * ratio)));
    const node = normalizeNode({
      id: uid("n"), type: "image", fileId,
      x: Math.round(pos.x - w / 2), y: Math.round(pos.y - h / 2), w, h,
    });
    board.items.push(node);
    selection = { nodes: new Set([node.id]), edges: new Set() };
    markDirty();
    render();
    await save();
  });

  /* ---------- 素材抽屉：跟随左侧文件夹 + 可选标签 ---------- */
  let drawerIO = null;
  let drawerSeq = 0;
  const drawerOpts = {
    subfolders: localStorage.getItem("texture.drawerSubfolders") !== "0",
    tags: localStorage.getItem("texture.drawerTags") === "1",
  };

  function galleryFilter() {
    try {
      return state.filter || {};
    } catch {
      return {};
    }
  }

  function syncDrawerOpts() {
    const a = $("#drawer-subfolders");
    const b = $("#drawer-tags");
    if (a) {
      a.classList.toggle("active", drawerOpts.subfolders);
      a.setAttribute("aria-pressed", String(drawerOpts.subfolders));
    }
    if (b) {
      b.classList.toggle("active", drawerOpts.tags);
      b.setAttribute("aria-pressed", String(drawerOpts.tags));
    }
  }

  async function loadDrawer() {
    const strip = $("#drawer-strip");
    const seq = ++drawerSeq;
    const f = galleryFilter();
    const qs = new URLSearchParams();
    if (f.dir) qs.set("dir", f.dir);
    if (f.family) qs.set("family", f.family);
    if (f.fav) qs.set("fav", "true");
    if (drawerOpts.tags && f.tag) qs.set("tag", f.tag);
    qs.set("subfolders", drawerOpts.subfolders ? "true" : "false");
    strip.innerHTML = '<div class="drawer-more">读取素材…</div>';
    let data;
    try {
      data = await api("/api/images?" + qs);
    } catch (e) {
      if (seq === drawerSeq) strip.innerHTML = `<div class="drawer-more">素材读取失败：${esc(e.message || e)}</div>`;
      return;
    }
    if (seq !== drawerSeq) return;
    strip.innerHTML = "";
    const count = $("#drawer-count");
    if (count) {
      const scope = f.dir ? baseName(f.dir) : "全部图片";
      count.textContent = `${scope} · ${data.items.length}`;
    }
    if (!data.items.length) {
      strip.innerHTML = '<div class="drawer-more">当前文件夹没有图片；可调整左侧目录或开启“显示子文件夹”。</div>';
      return;
    }
    const io = drawerIO || (drawerIO = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          const img = en.target;
          if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
          drawerIO.unobserve(img);
        }
      }
    }, { root: null, rootMargin: "300px" }));

    for (const it of data.items.slice(0, 400)) {
      const cell = createAssetCell(it, { onClick: () => {
        if (typeof selectImage === "function") selectImage(it.id);
        if (typeof setInspector === "function") setInspector(true);
      } });
      cell.classList.add("drawer-cell");
      const img = cell.querySelector("img");
      img.removeAttribute("loading");
      if (img.dataset.src) io.observe(img);
      strip.appendChild(cell);
    }
    if (data.items.length > 400) {
      const more = document.createElement("div");
      more.className = "drawer-more";
      more.textContent = `仅显示前 400 张（共 ${data.items.length}），可缩小文件夹范围`;
      strip.appendChild(more);
    }
  }

  $("#drawer-toggle").addEventListener("click", async () => {
    const d = $("#drawer");
    d.classList.toggle("collapsed");
    $("#drawer-toggle").classList.toggle("active", !d.classList.contains("collapsed"));
    if (!d.classList.contains("collapsed")) {
      syncDrawerOpts();
      await loadDrawer();
    }
  });
  $("#drawer-subfolders").addEventListener("click", () => {
    drawerOpts.subfolders = !drawerOpts.subfolders;
    localStorage.setItem("texture.drawerSubfolders", drawerOpts.subfolders ? "1" : "0");
    syncDrawerOpts();
    if (!$("#drawer").classList.contains("collapsed")) loadDrawer();
  });
  $("#drawer-tags").addEventListener("click", () => {
    drawerOpts.tags = !drawerOpts.tags;
    localStorage.setItem("texture.drawerTags", drawerOpts.tags ? "1" : "0");
    syncDrawerOpts();
    if (!$("#drawer").classList.contains("collapsed")) loadDrawer();
  });
  let drawerTimer = null;
  window.addEventListener("texture:gallery-updated", () => {
    if ($("#drawer").classList.contains("collapsed")) return;
    clearTimeout(drawerTimer);
    drawerTimer = setTimeout(loadDrawer, 120);
  });

  /* ---------- 工具栏 ---------- */
  $("#board-new").addEventListener("click", async () => {
    const name = await appPrompt("画板名称：", "参考板 " + new Date().toLocaleDateString());
    if (name == null || name === "") return;
    await flushSave();
    const { id } = await api("/api/boards", { method: "POST", body: { name } });
    await loadBoards(id);
  });

  $("#board-save").addEventListener("click", async () => {
    await flushSave();
    if (rev === savedRev) { setStatus("已保存", "ok"); toast("布局已保存"); }
    else toast("保存未完成，请检查服务是否在运行");
  });

  $("#board-delete").addEventListener("click", async () => {
    if (board.id == null) return;
    if (!(await appConfirm(`删除画板「${board.name}」？（图片文件不受影响）`))) return;
    const bid = board.id;
    await api(`/api/boards/${bid}`, { method: "DELETE" });
    try { localStorage.removeItem("texture.view." + bid); } catch { /* ignore */ }
    board.id = null;
    board.items = [];
    board.edges = [];
    await loadBoards();
  });

  $("#board-rename").addEventListener("click", async () => {
    if (board.id == null) return;
    const name = await appPrompt("画板名称：", board.name);
    if (name == null || name === "" || name === board.name) return;
    await api(`/api/boards/${board.id}`, { method: "PUT", body: { name } });
    board.name = name;
    const opt = $("#board-select").querySelector(`option[value="${board.id}"]`);
    if (opt) opt.textContent = name;
    toast("画板已重命名");
  });

  $("#board-select").addEventListener("change", async (ev) => {
    const id = Number(ev.target.value);
    if (!id || id === board.id) return;
    await loadBoard(id);
  });

  $("#board-export").addEventListener("click", async () => {
    if (board.id == null) return;
    await flushSave();
    location.href = `/api/export/board/${board.id}`;
  });

  async function exportCanvas() {
    if (board.id == null) return;
    await flushSave();
    location.href = `/api/export/canvas/${board.id}`;
  }
  $("#board-export-canvas").addEventListener("click", exportCanvas);

  $("#board-export-canvas-vault").addEventListener("click", async () => {
    if (board.id == null) return;
    const vault = await appPrompt(
      "输入 Obsidian 库根目录，图片会写成库内相对路径（留空则用绝对路径）：", "");
    await flushSave();
    const q = vault ? "?vault=" + encodeURIComponent(vault.trim()) : "";
    location.href = `/api/export/canvas/${board.id}${q}`;
  });

  /* ---------- ComfyUI 节点图送入画板 ---------- */
  async function addGraphToBoard(fid, opts = {}) {
    if (!fid) return 0;
    try {
      await ensureBoard();
    } catch (e) {
      toast("创建画板失败：" + (e && e.message ? e.message : e));
      return 0;
    }
    setStatus("导入节点图…");
    try {
      const res = await api(`/api/boards/${board.id}/import-graph`, {
        method: "POST",
        body: { fid, replace: false },
      });
      board.items = (res.board.items || []).map(normalizeNode);
      board.edges = (res.board.edges || []).map(normalizeEdge);
      rev = 0; savedRev = 0;
      selection = { nodes: new Set(), edges: new Set() };
      render();
      setStatus("已保存", "ok");
      toast(`已放入 ${res.nodes} 个节点、${res.edges} 条连线`);
      // 节点图往往很宽，整块 fit 会把字缩到看不清：
      // 先落在结果那一端（可读比例），要看全貌按 F。
      if (opts.fit !== false) {
        if (!res.imageNode || !centerOn(res.imageNode, 0.85)) fitView({ min: 0.5 });
      }
      if (typeof switchView === "function" && !$("#view-grid").hidden) {
        pendingFit = true;
        switchView("board");
      }
      return res.nodes;
    } catch (e) {
      setStatus("导入失败", "err");
      appAlert("节点图导入失败：" + (e && e.message ? e.message : e));
      return 0;
    }
  }
  window.addGraphToBoard = addGraphToBoard;

  /* 选中这个节点所有上游节点（往左走） */
  function selectUpstream(id) {
    const ids = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of board.edges) {
        if (e.to.node !== cur) continue;
        if (ids.has(e.from.node)) continue;
        ids.add(e.from.node);
        stack.push(e.from.node);
      }
    }
    if (!ids.size) { toast("这个节点没有上游"); return; }
    selection = { nodes: ids, edges: new Set() };
    syncSelection();
    toast(`已选中 ${ids.size} 个上游节点`);
  }

  /* ---------- .canvas 导入 ---------- */
  $("#board-import-canvas").addEventListener("click", () => $("#canvas-file").click());

  $("#canvas-file").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      appAlert("这个文件不是有效 JSON，无法作为 Obsidian .canvas 导入。");
      return;
    }
    if (!data || !Array.isArray(data.nodes)) {
      appAlert("这不是 Obsidian .canvas 文件（缺少 nodes 数组）。");
      return;
    }
    const vault = await appPrompt(
      "如果 .canvas 里的图片使用库内相对路径，请输入 Obsidian 库根目录；\n不确定可留空（会按绝对路径和全库唯一文件名匹配）：", "");
    try {
      await ensureBoard();
      setStatus("导入中…");
      const res = await api(`/api/boards/${board.id}/import-canvas`, {
        method: "POST",
        body: { canvas: data, vault: (vault || "").trim(), mode: "append" },
      });
      board.items = (res.board.items || []).map(normalizeNode);
      board.edges = (res.board.edges || []).map(normalizeEdge);
      rev = 0; savedRev = 0;
      selection = { nodes: new Set(), edges: new Set() };
      render();
      fitView();
      setStatus("已保存", "ok");
      const miss = res.missing || [];
      if (miss.length) {
        toast(`已导入 ${res.imported} 个节点；${miss.length} 张图片未匹配到图库，已保留占位`);
      } else {
        toast(`已导入 ${res.imported} 个节点 / ${res.imported_edges} 条连线`);
      }
    } catch (e) {
      setStatus("导入失败", "err");
      appAlert("导入失败：" + (e && e.message ? e.message : e));
    }
  });

  /* ---------- 缩放按钮 ---------- */
  $("#zoom-in").addEventListener("click", () => zoomAtCenter(1.2));
  $("#zoom-out").addEventListener("click", () => zoomAtCenter(1 / 1.2));
  $("#zoom-level").addEventListener("click", () => setZoom(1));
  $("#zoom-fit").addEventListener("click", fitView);

  /* ---------- 选中工具条 ---------- */
  $("#sel-del").addEventListener("click", deleteSelection);
  $("#sel-dup").addEventListener("click", duplicateSelection);
  $("#sel-front").addEventListener("click", () => reorderSelection(true));
  $("#sel-back").addEventListener("click", () => reorderSelection(false));
  $("#sel-label").addEventListener("click", () => {
    const id = [...selection.edges][0];
    const e = id && edgeById(id);
    if (e) editEdge(e);
  });

  $("#sel-style").addEventListener("click", (ev) => {
    ev.stopPropagation();
    const pop = $("#style-pop");
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      updateStyleControls();
      requestAnimationFrame(positionStylePop);
    }
  });
  $("#style-pop").addEventListener("mousedown", (ev) => ev.stopPropagation());
  $("#style-text-color").addEventListener("input", (ev) =>
    setSelectionTextStyle({ textColor: ev.target.value }));
  $("#style-text-default").addEventListener("click", () =>
    setSelectionTextStyle({ textColor: "" }));
  $("#style-font-size").addEventListener("change", (ev) =>
    setSelectionTextStyle({ fontSize: ev.target.value }));
  $("#style-font-family").addEventListener("change", (ev) =>
    setSelectionTextStyle({ fontFamily: ev.target.value }));
  $("#style-line-height").addEventListener("change", (ev) =>
    setSelectionTextStyle({ lineHeight: ev.target.value }));
  document.querySelectorAll("#style-align button").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSelectionTextStyle({ textAlign: btn.dataset.align });
    });
  });
  $("#style-reset").addEventListener("click", resetSelectionTextStyle);
  document.addEventListener("mousedown", (ev) => {
    const pop = $("#style-pop");
    if (!pop || pop.hidden) return;
    if (ev.target.closest("#style-pop") || ev.target.closest("#sel-style")) return;
    pop.hidden = true;
  });

  /* ---------- 白板键盘 ---------- */
  document.addEventListener("keydown", (ev) => {
    if ($("#view-board").hidden || editingText) return;
    if (!$("#lightbox").hidden) return;
    const t = document.activeElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const step = ev.shiftKey ? 10 : 1;

    if (ev.key === "Escape") {
      if (!$("#style-pop").hidden) { $("#style-pop").hidden = true; return; }
      clearSelection();
      return;
    }
    if (Hotkeys.match(ev, "board.text")) {
      ev.preventDefault(); $("#canvas-dock button[data-add='text']")?.click(); return;
    }
    if (Hotkeys.match(ev, "board.md")) {
      ev.preventDefault(); $("#canvas-dock button[data-add='md']")?.click(); return;
    }
    if (Hotkeys.match(ev, "board.group")) {
      ev.preventDefault(); $("#canvas-dock button[data-add='group']")?.click(); return;
    }
    if (Hotkeys.match(ev, "gallery.panel")) { Hotkeys.renderPanel(); $("#shortcuts").hidden = !$("#shortcuts").hidden; return; }
    if (Hotkeys.match(ev, "gallery.info")) {
      setInspector(!$("#main").classList.contains("insp-open")); return;
    }
    if (Hotkeys.match(ev, "gallery.nav")) {
      setNav(document.body.classList.contains("nav-closed")); return;
    }
    if (Hotkeys.match(ev, "board.del") || ev.key === "Backspace") {
      if (selection.nodes.size || selection.edges.size) { ev.preventDefault(); deleteSelection(); }
      return;
    }
    if (Hotkeys.match(ev, "board.dup")) {
      if (selection.nodes.size) { ev.preventDefault(); duplicateSelection(); }
      return;
    }
    if (mod && (ev.key === "c" || ev.key === "C")) {
      if (selection.nodes.size) { ev.preventDefault(); copySelection(); }
      return;
    }
    if (mod && (ev.key === "v" || ev.key === "V")) {
      if (clipboard) { ev.preventDefault(); pastePayload(clipboard); }
      return;
    }
    if (mod && (ev.key === "a" || ev.key === "A")) {
      ev.preventDefault(); selectAll(); return;
    }
    if (ev.key === "ArrowLeft") { ev.preventDefault(); nudge(-step, 0); return; }
    if (ev.key === "ArrowRight") { ev.preventDefault(); nudge(step, 0); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); nudge(0, -step); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); nudge(0, step); return; }
    if (Hotkeys.match(ev, "board.fit")) { ev.preventDefault(); fitView(); return; }
    if (Hotkeys.match(ev, "board.z100")) { ev.preventDefault(); setZoom(1); return; }
    if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); zoomAtCenter(1.2); return; }
    if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); zoomAtCenter(1 / 1.2); return; }
    if (Hotkeys.match(ev, "board.back")) { ev.preventDefault(); reorderSelection(false); return; }
    if (Hotkeys.match(ev, "board.front")) { ev.preventDefault(); reorderSelection(true); return; }
  });

  /* 双击空白：新建文本节点 */
  wrap.addEventListener("dblclick", (ev) => {
    if (ev.target.closest("#sel-toolbar") || ev.target.closest("#style-pop") ||
        ev.target.closest("#canvas-dock")) return;
    if (ev.target.closest(".b-item") || ev.target.closest("g[data-edge]")) return;
    addTextNode(toWorld(ev.clientX, ev.clientY));
  });

  /* ---------- 与主界面联动 ---------- */
  /* 图库右键「加入当前画板」：同一张图可以重复放入（节点 id 与 fileId 已分离） */
  window.addImagesToBoard = async (ids) => {
    if (!ids || !ids.length) return 0;
    await ensureBoard();
    const fromGallery = !$("#view-grid").hidden;
    const r = wrap.getBoundingClientRect();
    const wide = r.width > 40 && r.height > 40;
    const originX = wide ? Math.round((r.width / 2 - board.panX) / board.scale) - 120 : 80;
    const originY = wide ? Math.round((r.height / 2 - board.panY) / board.scale) - 90 : 80;
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(ids.length))));
    const W = 200, GAP = 26;
    let col = 0, x = originX, y = originY, rowH = 0;
    for (const fid of ids) {
      let dim = dimCache.get(fid);
      if (!dim) {
        try {
          const m = await api("/api/meta/" + encodeURIComponent(fid));
          dim = { w: m.pxw || 0, h: m.pxh || 0 };
        } catch { dim = { w: 0, h: 0 }; }
        dimCache.set(fid, dim);
      }
      if (col >= cols) { col = 0; x = originX; y += rowH + GAP; rowH = 0; }
      const ratio = dim.w > 0 ? dim.h / dim.w : 1;
      const h = Math.max(90, Math.round(W * ratio));
      const node = normalizeNode({
        id: uid("n"), type: "image", fileId: fid, x, y, w: W, h,
      });
      board.items.push(node);
      x += W + GAP;
      rowH = Math.max(rowH, h);
      col++;
    }
    markDirty();
    render();
    await save();
    if (fromGallery && typeof switchView === "function") {
      pendingFit = true;
      switchView("board");
    }
    return ids.length;
  };

  onSwitchToBoard = async () => {
    await loadBoards(board.id);
    syncDrawerOpts();
    if (!$("#drawer").classList.contains("collapsed")) {
      await loadDrawer();
    }
  };

  window.onLeaveBoard = async () => { await flushSave(); };

  window.addEventListener("pagehide", () => {
    if (board.id == null || rev === savedRev) return;
    try {
      fetch(`/api/boards/${board.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: board.items, edges: board.edges }),
        keepalive: true,
      });
    } catch { /* 关闭页时尽力而为 */ }
  });

  window.addEventListener("resize", () => updateSelToolbar());

  buildColorSwatches();
  syncDrawerOpts();

  /* 保存状态插在画板下拉框后 */
  const statusEl = document.createElement("span");
  statusEl.id = "board-status";
  statusEl.className = "board-status";
  $("#board-select").insertAdjacentElement("afterend", statusEl);

  syncToolbar();
})();