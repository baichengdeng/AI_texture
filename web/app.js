/* Texture 图库主逻辑：文件夹树 / 过滤 / 瀑布流 / 灯箱 / 收藏标签 / 批量操作 */
"use strict";

const $ = (sel) => document.querySelector(sel);

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem("texture.foldersCollapsed") || "[]"));
  } catch { return new Set(); }
}

const state = {
  items: [],
  idx: -1,
  selected: null,
  selection: new Set(),
  anchorIdx: -1,
  animateNext: true,
  visualOrder: [],
  layout: localStorage.getItem("texture.layout") || "masonry",   // masonry | uniform
  thumb: Number(localStorage.getItem("texture.thumb")) || 190,
  folders: [],            // 文件夹树
  rootPaths: new Set(),
  collapsed: readCollapsed(),
  filter: { q: "", source: "", model: "", sampler: "", ratio: "", sort: "time-desc",
            tag: "", fav: false, root: "", dir: "" },
};

const metaCache = new Map();

async function api(path, opts = {}) {
  if (opts.body && typeof opts.body === "object") {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  if (!r.ok) {
    const t = await r.text();
    toast(`请求失败 ${r.status}：${t.slice(0, 80)}`);
    throw new Error(`${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

function toast(msg) {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.classList.add("out"), 3100);
  setTimeout(() => el.remove(), 3600);
}

const filterActive = () => {
  const f = state.filter;
  return !!(f.q || f.source || f.model || f.sampler || f.ratio || f.tag || f.fav || f.root || f.dir);
};

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "已复制";
    btn.classList.remove("is-done");
    void btn.offsetWidth;
    btn.classList.add("is-done");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("is-done"); }, 900);
  }
}

/* ---------------- 主题 / 设置 ---------------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("texture.theme", theme); } catch { /* ignore */ }
}

/* ---------------- 图库加载与过滤 ---------------- */
async function loadImages() {
  const f = state.filter;
  const qs = new URLSearchParams();
  if (f.q) qs.set("q", f.q);
  if (f.source) qs.set("source", f.source);
  if (f.model) qs.set("model", f.model);
  if (f.sampler) qs.set("sampler", f.sampler);
  if (f.ratio) qs.set("ratio", f.ratio);
  if (f.sort !== "time-desc") qs.set("sort", f.sort);
  if (f.tag) qs.set("tag", f.tag);
  if (f.fav) qs.set("fav", "true");
  if (f.root) qs.set("root", f.root);
  if (f.dir) qs.set("dir", f.dir);
  if (!$("#lightbox").hidden) closeLightbox();
  const data = await api("/api/images?" + qs);
  state.items = data.items;
  $("#stat").textContent = `${String(data.total).padStart(3, "0")} 张`;
  fillSelect("#f-model", "全部模型", data.models, f.model);
  fillSelect("#f-sampler", "全部采样器", data.samplers, f.sampler);
  renderGrid();
  updateGridInfo();
  renderLibList();
}

function updateGridInfo() {
  const f = state.filter;
  const bits = [];
  if (f.dir) bits.push(baseName(f.dir) || f.dir);
  if (f.tag) bits.push("#" + f.tag);
  if (f.fav) bits.push("收藏");
  if (f.q) bits.push(`“${f.q}”`);
  const total = state.items.length;
  const head = bits.length ? bits.join(" / ") + " │ " : "";
  $("#grid-info").textContent = `${head}${total} 张`;
}

const baseName = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p || "");

function updateCellBadges(id) {
  const it = state.items.find((x) => x.id === id);
  const cell = document.querySelector(`.cell[data-id="${id}"]`);
  if (!it || !cell) return;
  cell.classList.toggle("fav", it.fav);
  const tagsEl = cell.querySelector(".tags");
  if (tagsEl) tagsEl.innerHTML = (it.tags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join("");
}

/* ---------------- 缩略图懒加载（全局一个观察器，图库与抽屉共用） ---------------- */
const imgIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target;
    if (img.dataset.src) {
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
    imgIO.unobserve(img);
  }
}, { rootMargin: "700px 0px" });

/* ---------------- 多选 ---------------- */

function onCellClick(ev, it, idx) {
  if (ev.ctrlKey || ev.metaKey) {
    state.selection.has(it.id) ? state.selection.delete(it.id) : state.selection.add(it.id);
    state.anchorIdx = idx;
    pickCell(it.id);
    syncSelectionBar();
    selectImage(it.id);
    return;
  }
  if (ev.shiftKey && state.anchorIdx >= 0) {
    const [a, b] = [state.anchorIdx, idx].sort((x, y) => x - y);
    state.selection = new Set(state.items.slice(a, b + 1).map((x) => x.id));
    document.querySelectorAll(".cell").forEach((c) =>
      c.classList.toggle("picked", state.selection.has(c.dataset.id)));
    syncSelectionBar();
    selectImage(it.id);
    return;
  }
  if (state.selection.size) {
    state.selection.clear();
    document.querySelectorAll(".cell.picked").forEach((c) => c.classList.remove("picked"));
    syncSelectionBar();
  }
  state.anchorIdx = idx;
  selectImage(it.id);
}

function pickCell(id) {
  const cell = document.querySelector(`.cell[data-id="${id}"]`);
  if (cell) cell.classList.toggle("picked", state.selection.has(id));
}

function syncSelectionBar() {
  const bar = $("#selection-bar");
  bar.hidden = state.selection.size === 0;
  $("#sel-count").textContent = `已选 ${state.selection.size} 张`;
}

async function batchFav() {
  const ids = [...state.selection];
  const anyUnfav = state.items.filter((x) => ids.includes(x.id)).some((x) => !x.fav);
  for (const id of ids) {
    await api("/api/fav", { method: "POST", body: { id, value: anyUnfav } });
    const it = state.items.find((x) => x.id === id);
    if (it) it.fav = anyUnfav;
    const m = metaCache.get(id);
    if (m) m.fav = anyUnfav;
    updateCellBadges(id);
  }
  toast(anyUnfav ? `已收藏 ${ids.length} 张` : `已取消收藏 ${ids.length} 张`);
  if (state.selected && ids.includes(state.selected)) $("#lb-fav").classList.toggle("on", anyUnfav);
  loadTags();
}

async function batchTag() {
  const name = await appPrompt("给选中的图片添加标签：");
  if (!name) return;
  const ids = [...state.selection];
  for (const id of ids) {
    await api("/api/tags", { method: "POST", body: { id, add: [name], remove: [] } });
    const it = state.items.find((x) => x.id === id);
    if (it) it.tags = [...new Set([...(it.tags || []), name])];
    const m = metaCache.get(id);
    if (m) m.tags = [...new Set([...(m.tags || []), name])];
    updateCellBadges(id);
  }
  toast(`已为 ${ids.length} 张图片添加标签「${name}」`);
  loadTags();
}

async function batchDelete(ids) {
  if (!ids.length) return;
  const ok = await appConfirm(
    `把 ${ids.length} 张图片移入系统回收站？\n（文件不会直接销毁，可在回收站恢复）`);
  if (!ok) return;
  const res = await api("/api/delete_files", { method: "POST", body: { ids } });
  ids.forEach((id) => metaCache.delete(id));
  state.selection.clear();
  state.selected = null;
  state.animateNext = false;
  toast(`已移入回收站 ${res.deleted} 张${res.failed ? `，失败 ${res.failed} 张` : ""}`);
  await loadImages(); loadFolders();
}

/* ---------------- 右键菜单 ---------------- */

function closeCtxMenu() { $("#ctx-menu").hidden = true; }

async function openCtxMenu(ev, it) {
  if (!state.selection.has(it.id)) {
    state.selection = new Set([it.id]);
    document.querySelectorAll(".cell").forEach((c) =>
      c.classList.toggle("picked", c.dataset.id === it.id));
    syncSelectionBar();
  }
  const single = state.selection.size === 1;
  const meta = metaCache.get(it.id) || {};
  const menu = $("#ctx-menu");
  const n = state.selection.size;
  menu.innerHTML = "";
  const add = (label, fn, cls = "") => {
    const d = document.createElement("div");
    d.className = "ctx-item " + cls;
    d.textContent = label;
    d.onclick = () => { closeCtxMenu(); fn(); };
    menu.appendChild(d);
  };
  add(single ? "★ 收藏 / 取消收藏" : `★ 批量收藏（${n} 张）`, single
    ? async () => {
        const it2 = state.items.find((x) => x.id === it.id);
        await api("/api/fav", { method: "POST", body: { id: it.id, value: !it2?.fav } });
        if (it2) { it2.fav = !it2.fav; updateCellBadges(it.id); }
        const m = metaCache.get(it.id); if (m) m.fav = it2?.fav;
        loadTags();
      }
    : batchFav);
  add(single ? "＋ 添加标签" : `＋ 批量标签（${n} 张）`, single
    ? () => { setInspector(true); $("#lb-tag-input").focus(); }
    : batchTag);
  if (single) {
    add("复制提示词", async () => copyText(meta.prompt || ""));
    add("复制负面提示词", async () => copyText(meta.negative || ""));
  }
  menu.insertAdjacentHTML("beforeend", '<div class="ctx-sep"></div>');
  if (single) add("打开原图", () => window.open("/api/file/" + it.id, "_blank"));
  add("在资源管理器中显示", () => fetch("/api/reveal/" + it.id).then(() => {}));
  if (single) add("复制文件路径", () => copyText(meta.file?.path || it.path));
  add("加入当前画板", async () => {
    const ok = await addSelectionToBoard();
    if (ok) toast(`已加入画板（${ok} 张）`);
  });
  menu.insertAdjacentHTML("beforeend", '<div class="ctx-sep"></div>');
  add(single ? "🗑 移入回收站" : `🗑 批量移入回收站（${n} 张）`,
    () => batchDelete([...state.selection]), "danger");
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(ev.clientX, innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(ev.clientY, innerHeight - mh - 8) + "px";
}
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#ctx-menu")) closeCtxMenu();
  if (!$("#shortcuts").hidden && !ev.target.closest("#shortcuts .sc-box")
      && !ev.target.closest("#topbar")) $("#shortcuts").hidden = true;
});
window.addEventListener("blur", closeCtxMenu);

function fillSelect(sel, allLabel, values, current) {
  const el = $(sel);
  el.innerHTML = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option${v === current ? " selected" : ""}>${esc(v)}</option>`).join("");
}

const SOURCE_LABEL = {
  comfyui: "ComfyUI", a1111: "A1111", novelai: "NAI",
  invokeai: "InvokeAI", easydiffusion: "EasyDiff", fooocus: "Fooocus",
  swarmui: "Swarm", drawthings: "Draw", none: "无", error: "错误",
};

/* ---------------- 瀑布流 / 等大网格布局 ---------------- */

function gridMetrics() {
  const grid = $("#grid");
  // 页边距就是 .grid 的左右内边距；--pad 是 clamp()，读计算后的实际值
  const cs = getComputedStyle(grid);
  const pad = Math.round(parseFloat(cs.paddingLeft) || 0);
  const gap = 8;
  const w = Math.max(0, grid.clientWidth - pad * 2);
  if (w <= 0) return null;
  const target = state.thumb;
  const cols = Math.max(1, Math.floor((w + gap) / (target + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  // 绝对定位子元素相对 padding 框，需要把内边距加回 left/top
  return { pad, gap, cols, cw };
}

function itemAspect(it) {
  if (state.layout === "uniform") return 1;
  return it && it.w > 0 && it.h > 0 ? it.h / it.w : 1;
}

function layoutMasonry() {
  const grid = $("#grid");
  const m = gridMetrics();
  if (!m) return;
  const heights = new Array(m.cols).fill(0);
  const placed = [];
  grid.querySelectorAll(".cell").forEach((cell) => {
    const it = state.items[+cell.dataset.idx];
    const c = heights.indexOf(Math.min(...heights));
    const top = heights[c];
    const h = Math.max(60, Math.round(m.cw * itemAspect(it)));
    cell.style.left = (m.pad + c * (m.cw + m.gap)) + "px";
    cell.style.top = (m.pad + top) + "px";
    cell.style.width = Math.round(m.cw) + "px";
    cell.style.height = h + "px";
    heights[c] += h + m.gap;
    placed.push({ id: cell.dataset.id, top, left: c * (m.cw + m.gap) });
  });
  const maxH = Math.max(0, Math.max(...heights) - m.gap);
  grid.style.height = (m.pad * 2 + maxH) + "px";
  state.visualOrder = placed.sort((a, b) => (a.top - b.top) || (a.left - b.left)).map((p) => p.id);
}

/* 图库与素材抽屉共用的格子工厂 */
function createAssetCell(it, opts = {}) {
  const { onClick, onDblClick, onContextMenu, index, className = "" } = opts;
  const cell = document.createElement("div");
  cell.className = ("cell" + (it.fav ? " fav" : "") +
    (state.selection.has(it.id) ? " picked" : "") + (className ? " " + className : "")).trim();
  cell.dataset.id = it.id;
  cell.draggable = true;
  cell.tabIndex = 0;
  cell.title = it.name + (it.prompt ? "\n" + it.prompt : "");
  cell.setAttribute("role", "button");
  cell.setAttribute("aria-label",
    `${it.name}${index != null ? "，第 " + (index + 1) + " 张" : ""}` +
    `${it.fav ? "，已收藏" : ""}${it.source && it.source !== "none" ? "，" + (SOURCE_LABEL[it.source] || it.source) : ""}`);
  if (index != null) cell.dataset.idx = index;
  cell.innerHTML = `
    <img data-src="/api/thumb/${it.id}?s=256" alt="" loading="lazy" decoding="async" draggable="false">
    <span class="badge src-${it.source}">${SOURCE_LABEL[it.source] || it.source}</span>
    <span class="star">★</span>
    ${index != null ? `<span class="no">${String(index + 1).padStart(3, "0")}</span>` : ""}
    <span class="tags">${(it.tags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join("")}</span>`;
  if (onClick) cell.addEventListener("click", (ev) => onClick(ev, cell));
  if (onDblClick) cell.addEventListener("dblclick", () => onDblClick(it));
  if (onContextMenu) cell.addEventListener("contextmenu", (ev) => { ev.preventDefault(); onContextMenu(ev, it); });
  cell.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      selectImage(it.id);
      if (ev.key === "Enter") openLightbox(it.id);
    }
  });
  cell.addEventListener("dragstart", (ev) => {
    ev.dataTransfer.setData("text/texture-id", it.id);
    ev.dataTransfer.setData("text/texture-name", it.name);
    ev.dataTransfer.effectAllowed = "copy";
  });
  imgIO.observe(cell.querySelector("img"));
  return cell;
}
window.createAssetCell = createAssetCell;

function renderGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  grid.classList.toggle("uniform", state.layout === "uniform");
  if (state.animateNext) grid.classList.add("first-in");
  const frag = document.createDocumentFragment();
  state.items.forEach((it, idx) => {
    const cell = createAssetCell(it, {
      index: idx,
      onClick: (ev) => onCellClick(ev, it, idx),
      onDblClick: (x) => openLightbox(x.id),
      onContextMenu: (ev, x) => openCtxMenu(ev, x),
    });
    if (!state.animateNext) cell.classList.add("no-anim");
    cell.style.setProperty("--i", Math.min(idx, 40));
    frag.appendChild(cell);
  });
  grid.appendChild(frag);
  state.animateNext = false;
  layoutMasonry();
  syncSelectionBar();
  if (state.selected) {
    const c = grid.querySelector(`.cell[data-id="${state.selected}"]`);
    if (c) c.classList.add("selected");
  }
  const empty = state.items.length === 0;
  $("#grid-empty").hidden = !empty;
  if (empty) {
    $("#grid-empty-text").textContent = filterActive()
      ? "没有匹配的图片。试试放宽或清除过滤条件。"
      : "图库是空的。点击右上角「添加文件夹」，选择存放 AI 生成图片的文件夹后，图片会出现在这里。";
    $("#btn-clear-filter").hidden = !filterActive();
  }
  updateGridInfo();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- 侧栏：文件树 / 标签 ---------------- */

async function loadFolders() {
  let roots = [];
  try {
    const data = await api("/api/folders");
    roots = data.roots || [];
  } catch { roots = []; }
  state.folders = roots;
  state.rootPaths = new Set(roots.map((r) => r.path));
  renderLibList();
  renderFolderTree();
}

function renderLibList() {
  const ul = $("#lib-list");
  const total = state.items.length;
  const favCount = state.items.filter((x) => x.fav).length;
  const noneCount = state.items.filter((x) => x.source === "none").length;
  const rows = [
    { key: "all", label: "全部图片", icon: "▦", n: total,
      active: !state.filter.dir && !state.filter.fav && !state.filter.source },
    { key: "fav", label: "收藏", icon: "★", n: favCount, active: state.filter.fav },
    { key: "none", label: "无元数据", icon: "∅", n: noneCount, active: state.filter.source === "none" },
  ];
  ul.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "nav-row" + (r.active ? " active" : "");
    li.innerHTML = `<span class="ico">${r.icon}</span><span class="label">${r.label}</span>` +
      `<span class="cnt">${r.n}</span>`;
    li.addEventListener("click", () => {
      if (r.key === "all") {
        state.filter.dir = ""; state.filter.fav = false; state.filter.source = "";
        $("#f-fav").checked = false; $("#f-source").value = "";
      } else if (r.key === "fav") {
        if (state.filter.fav) { state.filter.fav = false; $("#f-fav").checked = false; }
        else { state.filter.fav = true; $("#f-fav").checked = true; state.filter.dir = ""; }
      } else {
        state.filter.source = state.filter.source === "none" ? "" : "none";
        $("#f-source").value = state.filter.source;
      }
      loadImages(); loadFolders();
    });
    ul.appendChild(li);
  }
}

function renderFolderTree() {
  const host = $("#folder-tree");
  host.innerHTML = "";
  if (!state.folders.length) {
    host.innerHTML = '<li class="nav-row empty">未添加文件夹</li>';
    return;
  }
  const build = (nodes, parent) => {
    for (const node of nodes) {
      const li = document.createElement("li");
      li.className = "tree-item";
      li.dataset.path = node.path;
      const hasKids = node.children && node.children.length > 0;
      if (hasKids && state.collapsed.has(node.path)) li.classList.add("collapsed");
      const row = document.createElement("div");
      row.className = "nav-row tree-row" + (state.filter.dir === node.path ? " active" : "");
      row.title = node.path;
      row.innerHTML = `
        <button class="twisty${hasKids ? "" : " leaf"}" tabindex="-1">▸</button>
        <span class="ico">${state.rootPaths.has(node.path) ? "◉" : "▸"}</span>
        <span class="label">${esc(node.name || node.path)}</span>
        <span class="cnt">${node.total}</span>`;
      row.addEventListener("click", () => {
        state.filter.dir = state.filter.dir === node.path ? "" : node.path;
        loadImages(); loadFolders();
        if (!navPinned()) setNav(false);
      });
      const twisty = row.querySelector(".twisty");
      twisty.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!hasKids) return;
        li.classList.toggle("collapsed");
        if (li.classList.contains("collapsed")) state.collapsed.add(node.path);
        else state.collapsed.delete(node.path);
        try {
          localStorage.setItem("texture.foldersCollapsed", JSON.stringify([...state.collapsed]));
        } catch { /* ignore */ }
      });
      if (state.rootPaths.has(node.path)) {
        const rm = document.createElement("span");
        rm.className = "rm";
        rm.textContent = "✕";
        rm.title = "从图库移除（不删文件）";
        rm.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (!(await appConfirm(`从图库移除该文件夹？（不会删除文件）\n${node.path}`))) return;
          await api("/api/roots?path=" + encodeURIComponent(node.path), { method: "DELETE" });
          if (state.filter.dir === node.path) state.filter.dir = "";
          await loadImages(); loadFolders();
        });
        row.appendChild(rm);
      }
      li.appendChild(row);
      if (hasKids) {
        const ul = document.createElement("ul");
        ul.className = "tree-children";
        li.appendChild(ul);
        build(node.children, ul);
      }
      parent.appendChild(li);
    }
  };
  build(state.folders, host);
}

async function loadTags() {
  const { tags } = await api("/api/tags");
  const ul = $("#tag-list");
  const names = Object.keys(tags);
  ul.innerHTML = names.length ? "" : '<li class="nav-row empty">暂无标签</li>';
  names.forEach((n) => {
    const li = document.createElement("li");
    li.className = "nav-row" + (state.filter.tag === n ? " active" : "");
    li.innerHTML = `<span class="ico">#</span><span class="label">${esc(n)}</span>` +
      `<span class="cnt">${tags[n]}</span>`;
    li.addEventListener("click", () => {
      state.filter.tag = state.filter.tag === n ? "" : n;
      loadImages(); loadTags();
      if (!navPinned()) setNav(false);
    });
    ul.appendChild(li);
  });
}

async function loadSidebar() {
  await Promise.all([loadFolders(), loadTags()]);
}

/* ---------------- 信息栏与灯箱 ---------------- */

let currentMeta = null;

const inspPinned = () => localStorage.getItem("texture.inspPin") !== "0";

function refreshInspPin() {
  const btn = $("#insp-pin");
  btn.classList.toggle("on", inspPinned());
  btn.textContent = inspPinned() ? "已固定" : "固定";
}

function setInspector(open, save = true) {
  $("#main").classList.toggle("insp-open", open);
  $("#insp-toggle").textContent = open ? "›" : "‹";
  if (save) localStorage.setItem("texture.insp", open ? "1" : "0");
}

const inspSavedOpen = () => localStorage.getItem("texture.insp") !== "0";

async function selectImage(id) {
  state.selected = id;
  const idx = state.items.findIndex((x) => x.id === id);
  if (idx >= 0) state.idx = idx;
  document.querySelectorAll(".cell.selected").forEach((c) => c.classList.remove("selected"));
  const cell = document.querySelector(`.cell[data-id="${id}"]`);
  if (cell) {
    cell.classList.add("selected");
    cell.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const cached = metaCache.get(id);
  if (cached) { currentMeta = cached; fillInspector(cached); return; }
  const meta = await api("/api/meta/" + id);
  if (state.selected !== id) return;
  metaCache.set(id, meta);
  currentMeta = meta;
  fillInspector(meta);
}

function fillInspector(meta) {
  const params = meta.params || {};
  const fid = state.selected || meta.id || "";
  $("#insp-empty").hidden = true;
  const body = $("#insp-body");
  body.hidden = false;
  body.classList.remove("swap"); void body.offsetWidth; body.classList.add("swap");
  $("#lb-name").textContent = meta.file.name;
  $("#lb-name").title = meta.file.path;
  const thumb = $("#insp-thumb");
  thumb.src = `/api/thumb/${fid}?s=384`;
  thumb.parentElement.classList.add("has-img");
  const kb = (meta.file.size / 1024).toFixed(0);
  $("#lb-fileinfo").textContent =
    `${meta.file.path} · ${kb} KB · ${new Date(meta.file.mtime * 1000).toLocaleString()}`;
  const favBtn = $("#lb-fav");
  favBtn.textContent = meta.fav ? "★ 已收藏" : "☆ 收藏";
  favBtn.classList.toggle("on", meta.fav);
  renderTagChips(meta);
  const rows = [
    ["来源", meta.tool || meta.source],
    ["模型", params.model], ["采样器", params.sampler],
    ["Seed", params.seed], ["步数", params.steps],
    ["CFG", params.cfg],
    ["尺寸", params.size || (meta.pxw ? `${meta.pxw}×${meta.pxh}` : [meta.width, meta.height].filter(Boolean).join("×"))],
  ];
  $("#lb-param-table").innerHTML =
    rows.filter((r) => r[1]).map((r) => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`).join("") ||
    '<tr><td colspan="2" class="dim">无可识别参数</td></tr>';
  $("#lb-setting").textContent = meta.setting || "";
  $("#lb-setting").hidden = !meta.setting;
  $("#lb-pos").textContent = meta.prompt || "（无）";
  $("#lb-neg").textContent = meta.negative || "（无）";
  let raw = meta.raw || "";
  try {
    const obj = JSON.parse(raw);
    raw = JSON.stringify(obj, null, 2);
  } catch { /* 非纯 JSON 原样展示 */ }
  $("#lb-raw").textContent = raw || "（无原始数据）";
  $("#lb-copy-a1111").onclick = async (ev) => {
    const text = await (await fetch(`/api/export/a1111/${currentFileId()}`)).text();
    copyText(text, ev.target);
  };
  const wf = $("#lb-dl-workflow");
  wf.hidden = !meta.workflow_json && !meta.prompt_json;
  wf.href = `/api/export/comfy/${currentFileId()}`;
  wf.textContent = meta.workflow_json ? "下载 workflow.json" : "下载 prompt.json";
  $("#lb-dl-img").href = "/api/file/" + currentFileId();
}

function openLightbox(id) {
  clearTimeout(lbCloseTimer);
  selectImage(id);
  const lb = $("#lightbox");
  if (lb._finish) lb._finish();
  lb.classList.remove("closing");
  lb.hidden = false;
  if (!inspPinned()) setInspector(false, false);
  lbReset();
  lbSwapImage(id);
}

function renderTagChips(meta) {
  const wrap = $("#lb-tag-chips");
  wrap.innerHTML = "";
  for (const t of meta.tags || []) {
    const s = document.createElement("span");
    s.innerHTML = `${esc(t)} <i title="移除">✕</i>`;
    s.querySelector("i").addEventListener("click", async () => {
      const id = currentFileId();
      await api("/api/tags", { method: "POST", body: { id, add: [], remove: [t] } });
      meta.tags = meta.tags.filter((x) => x !== t);
      renderTagChips(meta);
      const it = state.items.find((x) => x.id === id);
      if (it) { it.tags = it.tags.filter((x) => x !== t); updateCellBadges(id); }
      loadTags();
    });
    wrap.appendChild(s);
  }
}

function currentFileId() {
  return state.selected ?? currentMeta?.id ?? "";
}

function closeLightbox() {
  const lb = $("#lightbox");
  if (lb.hidden) return;
  lb.classList.add("closing");
  clearTimeout(lbCloseTimer);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    lb._finish = null;
    lb.hidden = true;
    lb.classList.remove("closing");
    if (!inspPinned()) setInspector(inspSavedOpen(), false);
  };
  lb._finish = finish;
  lb.addEventListener("animationend", finish, { once: true });
  lbCloseTimer = setTimeout(finish, 220);
}

/* ---------------- 灯箱缩放/平移 ---------------- */

const lbView = { scale: 1, tx: 0, ty: 0 };
let lbCloseTimer = null;
function lbApply() {
  $("#lb-stage").style.transform = `translate(${lbView.tx}px, ${lbView.ty}px) scale(${lbView.scale})`;
  $("#lb-img").style.cursor = lbView.scale > 1 ? "grab" : "zoom-in";
}
function lbReset() { lbView.scale = 1; lbView.tx = 0; lbView.ty = 0; lbApply(); }

function lbSwapImage(id) {
  const under = $("#lb-img-under");
  const img = $("#lb-img");
  const url = "/api/file/" + id;
  if (img.src.endsWith(url)) return;
  if (img.classList.contains("loaded")) {
    under.src = img.src;
    under.style.width = img.naturalWidth ? "" : "100%";
  }
  img.classList.remove("loaded");
  img.onload = () => img.classList.add("loaded");
  img.src = url;
}

function bindLbZoom() {
  const left = $("#lb-left");
  left.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const next = Math.min(8, Math.max(0.2, lbView.scale * (ev.deltaY < 0 ? 1.2 : 1 / 1.2)));
    lbView.scale = next;
    if (next <= 1) { lbView.tx = 0; lbView.ty = 0; }
    lbApply();
  }, { passive: false });
  left.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("button") || lbView.scale <= 1) return;
    const sx = ev.clientX - lbView.tx, sy = ev.clientY - lbView.ty;
    const onMove = (e) => { lbView.tx = e.clientX - sx; lbView.ty = e.clientY - sy; lbApply(); };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  $("#lb-img").addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    lbView.scale = lbView.scale >= 2 ? 1 : 2;
    lbView.tx = 0; lbView.ty = 0;
    lbApply();
  });
}

function stepLightbox(dir) {
  if (!state.items.length) return;
  const order = state.visualOrder.length ? state.visualOrder : state.items.map((x) => x.id);
  let idx = order.indexOf(state.selected);
  if (idx < 0) idx = dir > 0 ? -1 : 0;
  const id = order[(idx + dir + order.length) % order.length];
  if ($("#lightbox").hidden) selectImage(id);
  else openLightbox(id);
}

/* ---------------- 抽屉导航 ---------------- */

function setNav(open, save = true) {
  document.body.classList.toggle("nav-closed", !open);
  if (save) localStorage.setItem("texture.nav", open ? "1" : "0");
}

const navPinned = () => localStorage.getItem("texture.navPin") === "1";

function refreshNavPin() {
  const btn = $("#nav-pin");
  btn.classList.toggle("on", navPinned());
  btn.textContent = navPinned() ? "已固定" : "固定";
}

function bindNav() {
  // 宽屏默认展开；窄屏（浮层会挡住内容）默认收起。用户手动切换过就以记忆为准。
  const saved = localStorage.getItem("texture.nav");
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  const open = saved === null ? !narrow : saved !== "0";
  setNav(open, false);
  refreshNavPin();
  $("#nav-toggle").addEventListener("click", () =>
    setNav(document.body.classList.contains("nav-closed")));
  $("#nav-pin").addEventListener("click", () => {
    localStorage.setItem("texture.navPin", navPinned() ? "0" : "1");
    refreshNavPin();
  });
}

/* ---------------- 加入当前画板 ---------------- */
async function addSelectionToBoard() {
  // 交给 board.js：没有画板时自动建板，重复图片允许多次放入
  if (typeof window.addImagesToBoard !== "function") {
    toast("白板尚未就绪");
    return 0;
  }
  return window.addImagesToBoard([...state.selection]);
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  let searchTimer = null;
  const search = $("#search");
  const clearBtn = $("#search-clear");
  search.addEventListener("input", (ev) => {
    clearBtn.hidden = !ev.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filter.q = ev.target.value.trim();
      loadImages();
    }, 280);
  });
  clearBtn.addEventListener("click", () => {
    search.value = "";
    clearBtn.hidden = true;
    state.filter.q = "";
    loadImages();
    search.focus();
  });

  $("#f-source").addEventListener("change", (ev) => { state.filter.source = ev.target.value; loadImages(); });
  $("#f-model").addEventListener("change", (ev) => { state.filter.model = ev.target.value; loadImages(); });
  $("#f-sampler").addEventListener("change", (ev) => { state.filter.sampler = ev.target.value; loadImages(); });
  $("#f-ratio").addEventListener("change", (ev) => { state.filter.ratio = ev.target.value; loadImages(); });
  $("#f-sort").addEventListener("change", (ev) => { state.filter.sort = ev.target.value; loadImages(); });
  $("#f-fav").addEventListener("change", (ev) => { state.filter.fav = ev.target.checked; loadImages(); loadFolders(); });

  $("#btn-clear-filter").addEventListener("click", () => {
    state.filter = { q: "", source: "", model: "", sampler: "", ratio: "", sort: "time-desc",
                     tag: "", fav: false, root: "", dir: "" };
    search.value = "";
    clearBtn.hidden = true;
    $("#f-source").value = ""; $("#f-model").value = ""; $("#f-sampler").value = "";
    $("#f-ratio").value = ""; $("#f-fav").checked = false;
    loadImages(); loadSidebar();
  });

  $("#btn-add-root").addEventListener("click", async () => {
    const path = await pickFolder();
    if (!path) return;
    try {
      await api("/api/roots", { method: "POST", body: { path } });
    } catch (e) { appAlert("添加失败：" + e.message); return; }
    await loadImages(); loadSidebar();
  });

  const rescan = async () => {
    $("#stat").textContent = "扫描中…";
    metaCache.clear();
    state.animateNext = true;
    await api("/api/rescan", { method: "POST" });
    await loadImages(); loadSidebar();
    toast("已重新扫描");
  };
  $("#btn-rescan").addEventListener("click", rescan);
  $("#set-rescan").addEventListener("click", rescan);

  $("#bsel-fav").addEventListener("click", batchFav);
  $("#bsel-tag").addEventListener("click", batchTag);
  $("#bsel-del").addEventListener("click", () => batchDelete([...state.selection]));
  $("#bsel-clear").addEventListener("click", () => {
    state.selection.clear();
    document.querySelectorAll(".cell.picked").forEach((c) => c.classList.remove("picked"));
    syncSelectionBar();
  });

  $("#lb-close").addEventListener("click", closeLightbox);
  $("#lb-prev").addEventListener("click", () => stepLightbox(-1));
  $("#lb-next").addEventListener("click", () => stepLightbox(1));
  setInspector(inspSavedOpen(), false);
  refreshInspPin();
  $("#insp-toggle").addEventListener("click", () =>
    setInspector(!$("#main").classList.contains("insp-open")));
  $("#insp-pin").addEventListener("click", () => {
    localStorage.setItem("texture.inspPin", inspPinned() ? "0" : "1");
    refreshInspPin();
  });
  $("#lb-fav").addEventListener("click", async (ev) => {
    const id = currentFileId();
    if (!id) return;
    const now = !$("#lb-fav").classList.contains("on");
    await api("/api/fav", { method: "POST", body: { id, value: now } });
    ev.target.textContent = now ? "★ 已收藏" : "☆ 收藏";
    ev.target.classList.toggle("on", now);
    const it = state.items.find((x) => x.id === id);
    if (it) { it.fav = now; updateCellBadges(id); }
    const m = metaCache.get(id);
    if (m) m.fav = now;
    loadTags();
  });
  $("#lb-tag-input").addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter") return;
    const name = ev.target.value.trim();
    if (!name) return;
    const id = currentFileId();
    if (!id || !currentMeta) return;
    await api("/api/tags", { method: "POST", body: { id, add: [name], remove: [] } });
    ev.target.value = "";
    currentMeta.tags = [...(currentMeta.tags || []), name];
    const mc = metaCache.get(id);
    if (mc) mc.tags = [...new Set([...(mc.tags || []), name])];
    renderTagChips(currentMeta);
    const it = state.items.find((x) => x.id === id);
    if (it) { it.tags = [...(it.tags || []), name]; updateCellBadges(id); }
    loadTags();
  });
  document.querySelectorAll(".lb-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".lb-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-body").forEach((b) => (b.hidden = true));
      $("#tab-" + btn.dataset.tab).hidden = false;
    });
  });
  document.querySelectorAll(".copy[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = btn.dataset.copy === "pos" ? $("#lb-pos").textContent : $("#lb-neg").textContent;
      copyText(text === "（无）" ? "" : text, btn);
    });
  });

  /* 布局 / 缩略图尺寸 */
  const size = $("#thumb-size");
  size.value = state.thumb;
  size.addEventListener("input", (ev) => {
    state.thumb = Number(ev.target.value) || 190;
    localStorage.setItem("texture.thumb", state.thumb);
    layoutMasonry();
  });
  document.querySelectorAll("#layout-switch button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.layout === state.layout);
    btn.addEventListener("click", () => {
      state.layout = btn.dataset.layout;
      localStorage.setItem("texture.layout", state.layout);
      document.querySelectorAll("#layout-switch button").forEach((b) =>
        b.classList.toggle("active", b === btn));
      renderGrid();
    });
  });
  $("#grid").classList.toggle("uniform", state.layout === "uniform");

  /* 主题 */
  applyTheme(localStorage.getItem("texture.theme") || "dark");
  $("#set-theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    toast(next === "light" ? "已切换到浅色主题" : "已切换到深色主题");
  });
  $("#set-shortcuts").addEventListener("click", () => { $("#shortcuts").hidden = false; });

  document.addEventListener("keydown", (ev) => {
    const inField = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
      || document.activeElement?.isContentEditable;
    if (!$("#lightbox").hidden) {
      if (ev.key === "Escape") closeLightbox();
      if (ev.key === "ArrowLeft") stepLightbox(-1);
      if (ev.key === "ArrowRight") stepLightbox(1);
      if ((ev.key === "i" || ev.key === "I") && !inField) {
        setInspector(!$("#main").classList.contains("insp-open"));
      }
      return;
    }
    // 画板视图的快捷键由 board.js 负责，这里只处理图库
    if ($("#view-board").hidden === false) {
      if (ev.key === "Escape" && !$("#shortcuts").hidden) $("#shortcuts").hidden = true;
      return;
    }
    if (ev.key === "ArrowLeft" && !inField) stepLightbox(-1);
    if (ev.key === "ArrowRight" && !inField) stepLightbox(1);
    if (ev.key === "Enter" && !inField && state.selected) openLightbox(state.selected);
    if ((ev.key === "a" || ev.key === "A") && (ev.ctrlKey || ev.metaKey) && !inField) {
      ev.preventDefault();
      state.selection = new Set(state.items.map((x) => x.id));
      document.querySelectorAll(".cell").forEach((c) => c.classList.add("picked"));
      syncSelectionBar();
    }
    if (ev.key === "?" && !inField) $("#shortcuts").hidden = !$("#shortcuts").hidden;
    if ((ev.key === "i" || ev.key === "I") && !inField) {
      setInspector(!$("#main").classList.contains("insp-open"));
    }
    if (ev.key === "Escape") {
      if (!$("#shortcuts").hidden) { $("#shortcuts").hidden = true; return; }
      if (state.selection.size) {
        state.selection.clear();
        document.querySelectorAll(".cell.picked").forEach((c) => c.classList.remove("picked"));
        syncSelectionBar();
        return;
      }
      setNav(false);
    }
    if ((ev.key === "n" || ev.key === "N") && !inField && !ev.ctrlKey && !ev.altKey) {
      setNav(document.body.classList.contains("nav-closed"));
    }
  });

  document.querySelectorAll("#view-switch button").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  /* 顶栏 / 画板工具栏下拉菜单（统一收起逻辑） */
  document.addEventListener("click", (ev) => {
    document.querySelectorAll(".tb-menu").forEach((m) => {
      const wrapEl = m.parentElement;
      if (!wrapEl.contains(ev.target)) m.hidden = true;
    });
  });
  document.querySelectorAll(".tb-menu-wrap").forEach((wrapEl) => {
    const btn = wrapEl.querySelector(":scope > button");
    const menu = wrapEl.querySelector(".tb-menu");
    if (!btn || !menu) return;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = menu.hidden;
      document.querySelectorAll(".tb-menu").forEach((m) => (m.hidden = true));
      menu.hidden = !willOpen;
    });
  });
  // 菜单项点击后收起所在菜单
  document.querySelectorAll(".tb-menu .ctx-item").forEach((item) => {
    item.addEventListener("click", () => {
      const menu = item.closest(".tb-menu");
      if (menu) menu.hidden = true;
    });
  });
}

let onSwitchToBoard = null;
function switchView(view) {
  if (view !== "board" && typeof window.onLeaveBoard === "function") window.onLeaveBoard();
  document.querySelectorAll("#view-switch button").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const grid = $("#view-grid");
  const board = $("#view-board");
  grid.hidden = view !== "grid";
  board.hidden = view !== "board";
  const shown = view === "board" ? board : grid;
  shown.classList.remove("view-in");
  void shown.offsetWidth;
  shown.classList.add("view-in");
  if (view === "board" && onSwitchToBoard) onSwitchToBoard();
}

/* 侧栏分组折叠（状态记忆） */
function bindSectionCollapse() {
  document.querySelectorAll(".sb-section > .sec-head").forEach((head) => {
    const sec = head.parentElement;
    const key = "texture.sec." + sec.id;
    if (localStorage.getItem(key) === "1") sec.classList.add("collapsed");
    head.addEventListener("click", (ev) => {
      if (ev.target.closest(".sec-op")) return;
      sec.classList.toggle("collapsed");
      localStorage.setItem(key, sec.classList.contains("collapsed") ? "1" : "0");
    });
  });
}

/* ---------------- 启动 ---------------- */
bindEvents();
bindNav();
bindLbZoom();
bindSectionCollapse();
loadImages();
loadSidebar();
let masonryTimer = null;
new ResizeObserver(() => {
  clearTimeout(masonryTimer);
  masonryTimer = setTimeout(layoutMasonry, 80);
}).observe($("#grid"));