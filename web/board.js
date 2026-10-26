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
  const MIN_W = 60, MIN_H = 40;

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
    return e;
  }

  /* ---------- 视口 ---------- */
  function applyTransform() {
    canvas.style.transform = `translate(${board.panX}px, ${board.panY}px) scale(${board.scale})`;
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

  function edgeGeometry(e) {
    const a = nodeById(e.from.node), b = nodeById(e.to.node);
    if (!a || !b) return null;
    const p1 = anchorPos(a, e.from.side), p2 = anchorPos(b, e.to.side);
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
    if (!total) return;
    const box = selectionBBox();
    if (!box) { bar.hidden = true; return; }
    const r = wrap.getBoundingClientRect();
    let left = board.panX + box.x * board.scale;
    let top = board.panY + box.y * board.scale - 44;
    if (top < 6) top = board.panY + box.y2 * board.scale + 10;
    bar.style.left = clamp(left, 6, Math.max(6, r.width - 260)) + "px";
    bar.style.top = clamp(top, 6, Math.max(6, r.height - 40)) + "px";
  }

  /* ---------- 节点渲染 ---------- */
  function nodeClass(it) {
    const cls = ["b-item", "b-" + (it.type || "image")];
    if (it.color) cls.push("c" + it.color);
    if (selection.nodes.has(it.id)) cls.push("selected");
    if (it.type === "image" && !it.fileId) cls.push("missing");
    if (it.type === "comfy" && it.muted) cls.push("muted");
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
    } else if (it.type === "comfy") {
      el.innerHTML = comfyNodeHTML(it);
    } else if (it.type === "link") {
      el.innerHTML = `<div class="b-link"><span>🔗</span><span>${esc(it.url || "")}</span></div>`;
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

    el.insertAdjacentHTML("beforeend",
      `<div class="rz"></div><div class="b-del" title="删除节点">✕</div>`);
    for (const side of SIDES) {
      const dot = document.createElement("div");
      dot.className = `anchor a-${side}`;
      dot.dataset.side = side;
      el.appendChild(dot);
    }
    el.querySelector(".b-del").addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.querySelector(".b-del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeNodes([it.id]);
      markDirty();
      render();
    });
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
    for (const it of board.items) canvas.appendChild(buildNodeEl(it));
    applyTransform();
    updateSelToolbar();
    applyImgSrc();
  }

  /* ---------- 节点交互 ---------- */
  function bindNode(el, it) {
    el.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (spaceDown) return;                 // 空格按住时交给画布平移
      if (editingText === it.id) {
        // 点在编辑框里：交给浏览器放光标；点在框外：结束编辑再照常处理
        if (ev.target.closest(".b-text-body")) return;
        stopTextEdit();
      }
      if (ev.target.classList.contains("anchor")) {
        startLink(ev, it, ev.target.dataset.side);
        return;
      }
      ev.stopPropagation();
      const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
      if (additive) {
        selectNode(it.id, true);
        return;
      }
      if (!selection.nodes.has(it.id)) selectNode(it.id);
      if (ev.target.classList.contains("rz")) {
        if (selection.nodes.size === 1) startResize(ev, it, el);
        return;
      }
      startMove(ev);
    });

    el.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      if (it.type === "text") startTextEdit(it, el);
      else if (it.type === "image" && it.fileId) openLightbox(it.fileId);
      else if (it.type === "link" && it.url) window.open(it.url, "_blank");
    });

    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!selection.nodes.has(it.id)) selectNode(it.id);
      openNodeMenu(ev, it);
    });
  }

  function startMove(ev) {
    const drag = [];
    for (const id of selection.nodes) {
      const n = nodeById(id);
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

  function startResize(ev, it, el) {
    const sx = ev.clientX, sy = ev.clientY;
    const ow = it.w, oh = it.h;
    const keepRatio = it.type === "image" && !ev.altKey;
    const ratio = oh / Math.max(1, ow);
    let resized = false;
    const onMove = (e) => {
      let w = Math.max(MIN_W, Math.round(ow + (e.clientX - sx) / board.scale));
      let h = Math.max(MIN_H, Math.round(oh + (e.clientY - sy) / board.scale));
      if (keepRatio) h = Math.max(MIN_H, Math.round(w * ratio));
      it.w = w; it.h = h;
      el.style.width = w + "px";
      el.style.height = h + "px";
      resized = true;
      redrawEdges();
      updateSelToolbar();
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
    const body = el.querySelector(".b-text-body");
    if (!body) return;
    if (editingText === it.id) return;
    if (editingCommit) stopTextEdit();
    editingText = it.id;
    el.classList.add("editing");
    body.classList.add("editing");
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
      markDirty();
    };
    editingCommit = done;

    body.addEventListener("blur", done, { once: true });
    body.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { ev.preventDefault(); body.blur(); }
    });
    // 尺寸由用户拖角决定：内容超出时框内滚动，不再自动长高
    body.addEventListener("input", () => { markDirty(); });
  }

  /* ---------- 连线 ---------- */
  function startLink(ev, fromNode, fromSide) {
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
      canvas.querySelectorAll(".b-item.link-target").forEach((n) => n.classList.remove("link-target"));
      const hit = hitNode(e.clientX, e.clientY);
      if (hit && hit.id !== fromNode.id) hit.el.classList.add("link-target");
    };
    const onUp = (e) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      temp.remove();
      canvas.querySelectorAll(".b-item.link-target").forEach((n) => n.classList.remove("link-target"));
      const hit = hitNode(e.clientX, e.clientY);
      if (!hit || hit.id === fromNode.id) return;
      const toNode = nodeById(hit.id);
      if (!toNode) return;
      const dx = toNode.x + toNode.w / 2 - (fromNode.x + fromNode.w / 2);
      const dy = toNode.y + toNode.h / 2 - (fromNode.y + fromNode.h / 2);
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const toSide = horizontal ? (dx > 0 ? "left" : "right") : (dy > 0 ? "top" : "bottom");
      const fSide = horizontal ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
      board.edges.push({
        id: uid("e"),
        from: { node: fromNode.id, side: fSide },
        to: { node: toNode.id, side: toSide },
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
    const rest = board.items.filter((n) => !selection.nodes.has(n.id));
    board.items = front ? [...rest, ...picked] : [...picked, ...rest];
    markDirty();
    render();
  }

  function nudge(dx, dy) {
    if (!selection.nodes.size) return;
    for (const id of selection.nodes) {
      const n = nodeById(id);
      if (!n) continue;
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

  /* ---------- 框选 / 平移 / 缩放 ---------- */
  wrap.addEventListener("contextmenu", (ev) => {
    if (ev.target.closest("#sel-toolbar")) return;
    if (ev.target.closest(".b-item") || ev.target.closest("g[data-edge]")) return;
    ev.preventDefault();
    clearSelection();
    openBlankMenu(ev);
  });

  wrap.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("#sel-toolbar")) return;
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

  wrap.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey && !ev.deltaY) return;
    setZoom(board.scale * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), ev.clientX, ev.clientY);
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
    if (it.type === "text") items.push({ label: "编辑文本", fn: () => {
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
    items.push({ label: "删除", danger: true, fn: () => { deleteSelection(); } });
    openMenu(ev, items);
  }

  function openEdgeMenu(ev, e) {
    openMenu(ev, [
      { label: "编辑标签…", fn: () => editEdge(e) },
      { label: "清除标签", disabled: !e.label, fn: () => { delete e.label; markDirty(); render(); } },
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
  }

  $("#board-add-text").addEventListener("click", async () => {
    await ensureBoard();
    addTextNode(null);
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

  /* ---------- 素材抽屉 ---------- */
  let drawerIO = null;
  async function loadDrawer() {
    const strip = $("#drawer-strip");
    const data = await api("/api/images");
    strip.innerHTML = "";
    if (!data.items.length) {
      strip.innerHTML = '<div class="drawer-more">图库为空，先添加文件夹</div>';
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
      const cell = createAssetCell(it, { onClick: () => selectImage(it.id) });
      cell.classList.add("drawer-cell");
      const img = cell.querySelector("img");
      img.removeAttribute("loading");
      if (img.dataset.src) io.observe(img);
      strip.appendChild(cell);
    }
    if (data.items.length > 400) {
      const more = document.createElement("div");
      more.className = "drawer-more";
      more.textContent = `仅显示前 400 张（共 ${data.items.length}），可用搜索缩小范围`;
      strip.appendChild(more);
    }
  }

  $("#drawer-toggle").addEventListener("click", async () => {
    const d = $("#drawer");
    d.classList.toggle("collapsed");
    $("#drawer-toggle").classList.toggle("active", !d.classList.contains("collapsed"));
    if (!d.classList.contains("collapsed") && !d.dataset.loaded) {
      await loadDrawer();
      d.dataset.loaded = "1";
    }
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

  /* ---------- 白板键盘 ---------- */
  document.addEventListener("keydown", (ev) => {
    if ($("#view-board").hidden || editingText) return;
    if (!$("#lightbox").hidden) return;
    const t = document.activeElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const step = ev.shiftKey ? 10 : 1;

    if (ev.key === "Escape") { clearSelection(); return; }
    if (ev.key === "?") { $("#shortcuts").hidden = !$("#shortcuts").hidden; return; }
    if (!mod && (ev.key === "i" || ev.key === "I")) {
      setInspector(!$("#main").classList.contains("insp-open")); return;
    }
    if (!mod && (ev.key === "n" || ev.key === "N")) {
      setNav(document.body.classList.contains("nav-closed")); return;
    }
    if ((ev.key === "Delete" || ev.key === "Backspace")) {
      if (selection.nodes.size || selection.edges.size) { ev.preventDefault(); deleteSelection(); }
      return;
    }
    if (mod && (ev.key === "d" || ev.key === "D")) {
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
    if (!mod && (ev.key === "f" || ev.key === "F")) { ev.preventDefault(); fitView(); return; }
    if (ev.key === "0") { ev.preventDefault(); setZoom(1); return; }
    if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); zoomAtCenter(1.2); return; }
    if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); zoomAtCenter(1 / 1.2); return; }
    if (ev.key === "[") { ev.preventDefault(); reorderSelection(false); return; }
    if (ev.key === "]") { ev.preventDefault(); reorderSelection(true); return; }
  });

  /* 双击空白：新建文本节点 */
  wrap.addEventListener("dblclick", (ev) => {
    if (ev.target.closest("#sel-toolbar")) return;
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
    if (!$("#drawer").classList.contains("collapsed") && !$("#drawer").dataset.loaded) {
      await loadDrawer();
      $("#drawer").dataset.loaded = "1";
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

  /* 保存状态插在画板下拉框后 */
  const statusEl = document.createElement("span");
  statusEl.id = "board-status";
  statusEl.className = "board-status";
  $("#board-select").insertAdjacentElement("afterend", statusEl);

  syncToolbar();
})();