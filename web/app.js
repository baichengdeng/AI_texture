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
  facets: { total: 0, fav: 0, comfyui: 0, webui: 0, none: 0 },
  filter: { q: "", family: "", sort: "time-desc",
            tag: "", tags: [], fav: false, root: "", dir: "",
            subfolders: localStorage.getItem("texture.gallerySubfolders") !== "0" },
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
  return !!(f.q || f.family || f.tag || (f.tags && f.tags.length) || f.fav || f.root || f.dir);
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
  if (f.family) qs.set("family", f.family);
  if (f.sort !== "time-desc") qs.set("sort", f.sort);
  if (f.tag) qs.set("tag", f.tag);
  if (f.fav) qs.set("fav", "true");
  if (f.root) qs.set("root", f.root);
  if (f.dir) qs.set("dir", f.dir);
  if (!f.subfolders) qs.set("subfolders", "false");
  if (f.tags && f.tags.length) qs.set("tags", f.tags.join(","));
  if (!$("#lightbox").hidden) closeLightbox();
  const data = await api("/api/images?" + qs);
  state.items = data.items;
  renderGrid();
  updateGridInfo();
  renderLibList();
  syncFolderActive();
  renderPromptChips();
  window.dispatchEvent(new CustomEvent("texture:gallery-updated", {
    detail: { filter: { ...state.filter } },
  }));
}

async function loadFacets() {
  const qs = new URLSearchParams();
  if (state.filter.dir) qs.set("dir", state.filter.dir);
  if (!state.filter.subfolders) qs.set("subfolders", "false");
  try {
    state.facets = await api("/api/facets?" + qs);
  } catch {
    state.facets = {
      total: state.items.length,
      fav: state.items.filter((x) => x.fav).length,
      comfyui: state.items.filter((x) => x.family === "comfyui").length,
      webui: state.items.filter((x) => x.family === "webui").length,
      none: state.items.filter((x) => x.family === "none").length,
    };
  }
  renderLibList();
}

function updateGridInfo() {
  const f = state.filter;
  const bits = [];
  if (f.dir) bits.push(baseName(f.dir) || f.dir);
  if (f.family) bits.push(f.family === "comfyui" ? "ComfyUI" : f.family === "webui" ? "WebUI" : "无数据");
  if (f.tag) bits.push("#" + f.tag);
  if (f.tags && f.tags.length) bits.push(f.tags.map((t) => "#" + t).join(" "));
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
    d.innerHTML = label;   // 允许标签里带 <i class="ic"> 图标
    d.onclick = () => { closeCtxMenu(); fn(); };
    menu.appendChild(d);
  };
  add(single ? '<i class="ic" data-ic="star"></i> 收藏 / 取消收藏' : `<i class="ic" data-ic="star"></i> 批量收藏（${n} 张）`, single
    ? async () => {
        const it2 = state.items.find((x) => x.id === it.id);
        await api("/api/fav", { method: "POST", body: { id: it.id, value: !it2?.fav } });
        if (it2) { it2.fav = !it2.fav; updateCellBadges(it.id); }
        const m = metaCache.get(it.id); if (m) m.fav = it2?.fav;
        loadTags();
      }
    : batchFav);
  add(single ? '<i class="ic" data-ic="attach"></i> 添加标签' : `<i class="ic" data-ic="attach"></i> 批量标签（${n} 张）`, single
    ? () => { setInspector(true); $("#lb-tag-input").focus(); }
    : batchTag);
  if (single) {
    add("复制提示词", async () => copyText(meta.prompt || ""));
    add("复制负面提示词", async () => copyText(meta.negative || ""));
  }
  menu.insertAdjacentHTML("beforeend", '<div class="ctx-sep"></div>');
  if (single) add('<i class="ic" data-ic="enter"></i> 打开原图', () => window.open("/api/file/" + it.id, "_blank"));
  add('<i class="ic" data-ic="locate"></i> 在资源管理器中显示', () => fetch("/api/reveal/" + it.id).then(() => {}));
  if (single) add("复制文件路径", () => copyText(meta.file?.path || it.path));
  add("加入当前画板", async () => {
    const ok = await addSelectionToBoard();
    if (ok) toast(`已加入画板（${ok} 张）`);
  });
  menu.insertAdjacentHTML("beforeend", '<div class="ctx-sep"></div>');
  add(single ? '<i class="ic" data-ic="ashbin"></i> 移入回收站' : `<i class="ic" data-ic="ashbin"></i> 批量移入回收站（${n} 张）`,
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
  const familyLabel = it.family === "comfyui" ? "ComfyUI"
    : it.family === "webui" ? "WebUI" : "无数据";
  const cell = document.createElement("div");
  cell.className = ("cell" + (it.fav ? " fav" : "") +
    (state.selection.has(it.id) ? " picked" : "") + (className ? " " + className : "")).trim();
  cell.dataset.id = it.id;
  cell.draggable = true;
  cell.tabIndex = 0;
  cell.title = `${it.name}\n${familyLabel}${it.tool ? " · " + it.tool : ""}` +
    (it.prompt ? "\n" + it.prompt : "");
  cell.setAttribute("role", "button");
  cell.setAttribute("aria-label",
    `${it.name}${index != null ? "，第 " + (index + 1) + " 张" : ""}` +
    `${it.fav ? "，已收藏" : ""}，${familyLabel}`);
  if (index != null) cell.dataset.idx = index;
  cell.innerHTML = `
    <img data-src="/api/thumb/${it.id}?s=256" alt="" loading="lazy" decoding="async" draggable="false">
    <span class="badge src-${it.family || it.source}">${familyLabel}</span>
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
  await loadFacets();
  renderFolderTree();
}

function renderLibList() {
  const ul = $("#lib-list");
  const counts = state.facets || {};
  const rows = [
    { key: "all", label: "全部图片", icon: "▦", n: counts.total || 0,
      active: !state.filter.dir && !state.filter.fav && !state.filter.family && !state.filter.tag },
    { key: "fav", label: "收藏", icon: "★", n: counts.fav || 0, active: state.filter.fav },
    { key: "comfyui", label: "ComfyUI", icon: "◇", n: counts.comfyui || 0,
      active: state.filter.family === "comfyui" },
    { key: "webui", label: "WebUI", icon: "◎", n: counts.webui || 0,
      active: state.filter.family === "webui" },
    { key: "none", label: "无数据", icon: "∅", n: counts.none || 0,
      active: state.filter.family === "none" },
  ];
  ul.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "nav-row" + (r.active ? " active" : "");
    li.innerHTML = `<span class="ico">${r.icon}</span><span class="label">${r.label}</span>` +
      `<span class="cnt">${r.n}</span>`;
    li.addEventListener("click", async () => {
      if (r.key === "all") {
        state.filter.dir = "";
        state.filter.fav = false;
        state.filter.family = "";
        state.filter.tag = "";
      } else if (r.key === "fav") {
        state.filter.fav = !state.filter.fav;
        state.filter.dir = "";
        state.filter.family = "";
      } else {
        state.filter.family = state.filter.family === r.key ? "" : r.key;
        state.filter.dir = "";
        state.filter.fav = false;
      }
      await Promise.all([loadImages(), loadFacets()]);
      if (!navPinned()) setNav(false);
    });
    ul.appendChild(li);
  }
  const favToggle = $("#f-fav");
  if (favToggle) favToggle.checked = state.filter.fav;
}

function renderFolderTree() {
  const host = $("#folder-tree");
  host.innerHTML = "";
  if (!state.folders.length) {
    host.innerHTML = '<li class="nav-row empty">未添加文件夹</li>';
    return;
  }
  // 当前选中的目录如果在折叠的父级里，自动展开父级，否则看不到高亮
  if (state.filter.dir) {
    let changed = false;
    for (const root of state.folders) {
      if (!root.children) continue;
      for (const kid of root.children) {
        if (state.filter.dir === kid.path || state.filter.dir.startsWith(kid.path + "\\") ||
            state.filter.dir.startsWith(kid.path + "/")) {
          if (state.collapsed.delete(root.path)) changed = true;
        }
      }
    }
    if (changed) {
      try {
        localStorage.setItem("texture.foldersCollapsed", JSON.stringify([...state.collapsed]));
      } catch { /* ignore */ }
    }
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
      const isRoot = state.rootPaths.has(node.path);
      row.innerHTML = `
        <button class="twisty${hasKids ? "" : " leaf"}" tabindex="-1" aria-label="${hasKids ? "展开或折叠" : ""}">▸</button>
        <span class="label">${esc(node.name || node.path)}</span>
        <span class="cnt">${node.total}</span>`;
      row.setAttribute("aria-expanded", hasKids ? String(!state.collapsed.has(node.path)) : "");
      row.addEventListener("click", () => {
        state.filter.dir = state.filter.dir === node.path ? "" : node.path;
        syncFolderActive();
        loadImages().then(loadFacets);
        if (!navPinned()) setNav(false);
      });
      const twisty = row.querySelector(".twisty");
      twisty.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!hasKids) return;
        li.classList.toggle("collapsed");
        if (li.classList.contains("collapsed")) state.collapsed.add(node.path);
        else state.collapsed.delete(node.path);
        row.setAttribute("aria-expanded", String(!li.classList.contains("collapsed")));
        try {
          localStorage.setItem("texture.foldersCollapsed", JSON.stringify([...state.collapsed]));
        } catch { /* ignore */ }
      });
      if (isRoot) {
        const rm = document.createElement("span");
        rm.className = "rm";
        rm.innerHTML = '<i class="ic" data-ic="close"></i>';
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

/* 只切高亮，不重建整棵树：避免点一下文件夹就闪一次 */
function syncFolderActive() {
  document.querySelectorAll("#folder-tree .tree-row").forEach((row) => {
    row.classList.toggle("active", row.parentElement?.dataset.path === state.filter.dir);
  });
}

/* 标签排序：名称 / 数量（记忆）；右键标签 → 重命名 / 删除 */
let tagSortMode = localStorage.getItem("texture.tagSort") || "name-asc";

async function loadTags() {
  const { tags } = await api("/api/tags");
  const ul = $("#tag-list");
  const inner = document.querySelector("#sec-tags .sec-inner");
  // 排序下拉单独占一行挂在列表上方（不进分组标题，避免把标题挤断行）
  if (inner && !inner.querySelector("#tag-sort")) {
    const wrap = document.createElement("div");
    wrap.className = "sec-tools";
    const sel = document.createElement("select");
    sel.id = "tag-sort";
    sel.title = "标签排序";
    sel.innerHTML = `
      <option value="name-asc">名称 A→Z</option>
      <option value="name-desc">名称 Z→A</option>
      <option value="count-desc">数量 多→少</option>
      <option value="count-asc">数量 少→多</option>`;
    sel.value = tagSortMode;
    sel.addEventListener("change", () => {
      tagSortMode = sel.value;
      localStorage.setItem("texture.tagSort", tagSortMode);
      loadTags();
    });
    wrap.appendChild(sel);
    inner.insertBefore(wrap, ul);
  }
  let names = Object.keys(tags);
  const byName = (a, b) => a.localeCompare(b, "zh");
  const byCount = (a, b) => (tags[b] - tags[a]) || byName(a, b);
  if (tagSortMode === "name-asc") names.sort(byName);
  else if (tagSortMode === "name-desc") names.sort((a, b) => byName(b, a));
  else if (tagSortMode === "count-desc") names.sort(byCount);
  else names.sort((a, b) => -byCount(a, b));
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
    li.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      openTagMenu(ev, n);
    });
    ul.appendChild(li);
  });
}

/* 标签右键菜单：重命名（全部图片同步） / 删除（全部图片同步移除） */
function openTagMenu(ev, name) {
  const menu = $("#ctx-menu");
  menu.innerHTML = "";
  const add = (label, fn, cls = "") => {
    const d = document.createElement("div");
    d.className = "ctx-item " + cls;
    d.textContent = label;
    d.onclick = async () => {
      closeCtxMenu();
      await fn();
    };
    menu.appendChild(d);
  };
  add('<i class="ic" data-ic="edit"></i> 重命名标签', async () => {
    const newName = (await appPrompt(`重命名标签「${name}」
（所有图片同步修改）：`, name)) || "";
    if (!newName.trim() || newName.trim() === name) return;
    try {
      await api("/api/tags/rename", { method: "POST", body: { old: name, new: newName.trim() } });
      toast(`已重命名为「${newName.trim()}」`);
    } catch (e) {
      toast("重命名失败：" + String(e.message || e).slice(0, 60));
    }
    if (state.filter.tag === name) state.filter.tag = newName.trim();
    loadTags(); loadImages();
  });
  add('<i class="ic" data-ic="ashbin"></i> 删除标签', async () => {
    if (!(await appConfirm(`删除标签「${name}」？
（所有图片上的这个标签都会移除，图片文件不受影响）`))) return;
    try {
      await api("/api/tags?name=" + encodeURIComponent(name), { method: "DELETE" });
      toast("标签已删除");
    } catch (e) {
      toast("删除失败：" + String(e.message || e).slice(0, 60));
    }
    if (state.filter.tag === name) state.filter.tag = "";
    loadTags(); loadImages();
  }, "danger");
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(ev.clientX, innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(ev.clientY, innerHeight - mh - 8) + "px";
}

async function loadSidebar() {
  await Promise.all([loadFolders(), loadTags()]);
}

/* ---------------- 信息栏与灯箱 ---------------- */

let currentMeta = null;
let boardNodeEdit = null;

const BOARD_NODE_KIND = {
  text: "文本节点", md: "Markdown 文件", group: "分组",
  link: "链接卡片", comfy: "ComfyUI 节点",
};

function boardNodeTitle(node) {
  if (node.type === "group") return node.label || "分组";
  if (node.type === "link") return node.url || "链接卡片";
  if (node.type === "comfy") return node.title || node.cls || "ComfyUI 节点";
  const first = String(node.text || "").split("\n").find((s) => s.trim()) || "";
  return first.replace(/^#{1,6}\s*/, "").slice(0, 60) ||
    (node.type === "md" ? "未命名 Markdown" : "文本节点");
}

/* 信息栏标题：既是显示，也是改名入口。
   editable=true 时可直接编辑（仅图片）；画布节点、空态都只读。 */
function setInspName(text, opts = {}) {
  const el = $("#lb-name");
  if (!el) return;
  el.value = text || "";
  el.readOnly = !opts.editable;
  el.title = opts.title || (opts.editable ? "点击可重命名" : "");
  el.dataset.base = text || "";
}

function hideBoardNodeEditor() {
  boardNodeEdit = null;
  const panel = $("#insp-board-node");
  if (panel) panel.hidden = true;
}

/* 画布节点 → 右侧介绍栏。文字 / Markdown / 组直接在介绍栏编辑，
   图片仍复用图库详情，因此参数、标签、导出能力完全一致。 */
function showBoardNodeInspector(node, opts = {}) {
  hideBoardNodeEditor();
  boardNodeEdit = { id: node.id, opts };
  state.selected = null;
  currentMeta = null;
  $("#insp-empty").hidden = true;
  $("#insp-body").hidden = true;
  $("#insp-thumb").removeAttribute("src");
  $("#insp-thumb").parentElement.classList.remove("has-img");

  setInspName(boardNodeTitle(node), { title: BOARD_NODE_KIND[node.type] || "画布节点" });
  const kind = $("#insp-node-kind");
  kind.textContent = BOARD_NODE_KIND[node.type] || "画布节点";
  $("#insp-node-size").textContent =
    `${Math.round(node.w)} × ${Math.round(node.h)}`;
  const label = $("#insp-node-label");
  const text = $("#insp-node-text");
  const hint = $("#insp-node-hint");
  const isComfy = node.type === "comfy";
  label.textContent = node.type === "group" ? "组名称"
    : node.type === "link" ? "链接地址"
    : node.type === "md" ? "Markdown 内容"
    : isComfy ? "节点参数（只读）" : "文本内容";
  text.readOnly = isComfy;
  text.value = node.type === "group" ? (node.label || "")
    : node.type === "link" ? (node.url || "")
    : isComfy
      ? [node.title || node.cls, ...(node.widgets || []).map((w) => `${w.k}: ${w.v}`)].join("\n")
      : (node.text || "");
  hint.textContent = isComfy
    ? "ComfyUI 节点由节点图导入，参数只读；可在画布上移动或删除。"
    : "修改会实时同步到画布，并自动保存。";
  panelShow("#insp-board-node");
  setInspector(true);
  if (opts.focus) setTimeout(() => text.focus(), 30);
}

function panelShow(sel) {
  $(sel).hidden = false;
}

function onBoardNodeInput(value) {
  if (!boardNodeEdit) return;
  boardNodeEdit.opts.onChange?.(value);
}

window.showBoardNodeInspector = showBoardNodeInspector;
window.hideBoardNodeInspector = hideBoardNodeEditor;
window.setInspectorName = setInspName;

const inspPinned = () => localStorage.getItem("texture.inspPin") !== "0";

/* 图钉不再是单独的按钮：固定状态直接挂在「信息栏」开关上（默认展开即固定）。
   Alt / Shift 点击开关 = 只切固定，不动开合。 */
function refreshInspPin() {
  const btn = $("#insp-toggle");
  if (!btn) return;
  const open = $("#main").classList.contains("insp-open");
  const on = open && inspPinned();
  btn.classList.toggle("pinned", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = !open ? "展开信息栏 (I)"
    : on ? "信息栏已固定：放大看图时不收起（Alt+点击可取消固定）"
    : "信息栏未固定：放大看图会自动收起（Alt+点击改回固定）";
}

function setInspector(open, save = true, autoPin = true) {
  $("#main").classList.toggle("insp-open", open);
  const btn = $("#insp-toggle");
  if (btn) {
    btn.classList.toggle("on", open);
    btn.setAttribute("aria-expanded", String(open));
  }
  // 默认打开即固定
  if (open && autoPin) localStorage.setItem("texture.inspPin", "1");
  if (save) localStorage.setItem("texture.insp", open ? "1" : "0");
  refreshInspPin();
}

const inspSavedOpen = () => localStorage.getItem("texture.insp") !== "0";

/* 从画板回到图库时，把信息栏恢复成图库语义：
   有选中图片就显示详情，没有就回到空态提示。 */
function restoreGalleryInspector() {
  const node = $("#insp-board-node");
  if (node) node.hidden = true;
  if (state.selected) {
    const cached = metaCache.get(state.selected);
    if (cached) { currentMeta = cached; fillInspector(cached); return; }
    api("/api/meta/" + state.selected)
      .then((meta) => {
        if (state.selected) { metaCache.set(state.selected, meta); currentMeta = meta; fillInspector(meta); }
      })
      .catch(() => {});
    return;
  }
  currentMeta = null;
  setInspName("未选择图片");
  $("#insp-thumb").removeAttribute("src");
  $("#insp-thumb").parentElement.classList.remove("has-img");
  $("#insp-body").hidden = true;
  $("#insp-empty").hidden = false;
}

async function selectImage(id) {
  hideBoardNodeEditor();
  if (tagSaveTimer) await flushTagDoc();   // 切图前先把没落盘的胶囊存了
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
  setInspName(meta.file.name, { editable: true, title: meta.file.path });
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
  loadGraphTab(meta, fid);
  const src = meta.source || "none";
  const family = src === "comfyui" ? "ComfyUI"
    : src === "none" || src === "error" ? "无数据" : "WebUI";
  const rows = [
    ["来源", family + (src !== "comfyui" && src !== "none" && src !== "error"
      ? " · " + (meta.tool || src) : "")],
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
  // 没有提示词时只留胶囊；有就并列显示
  const hasPos = !!String(meta.prompt || "").trim();
  const hasNeg = !!String(meta.negative || "").trim();
  const posSec = $("#pb-pos-sec");
  const negSec = $("#pb-neg-sec");
  if (posSec) posSec.hidden = !hasPos;
  if (negSec) negSec.hidden = !hasNeg;
  renderPromptChips();
  loadTagDoc(meta);
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

/* ---------------- 提示词胶囊（词框） ---------------- */

/* 提示词按逗号 / 换行切块。原文保留（用于精确检索），不做归一化改写。 */
function splitPromptTags(text) {
  return String(text || "")
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function qTerms() {
  return String(state.filter.q || "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setQTerms(terms) {
  state.filter.q = terms.join(", ");
  const box = $("#search");
  if (box) box.value = state.filter.q;
  const clear = $("#search-clear");
  if (clear) clear.hidden = !state.filter.q;
}

/* 点胶囊 = 按这个 tag 找同款；Ctrl / Shift 点击 = 追加，多个 tag 之间是 AND */
function togglePromptChip(raw, additive) {
  const terms = qTerms();
  const at = terms.indexOf(raw);
  if (additive) {
    if (at >= 0) terms.splice(at, 1);
    else terms.push(raw);
  } else if (terms.length === 1 && at === 0) {
    terms.length = 0;
  } else {
    terms.splice(0, terms.length, raw);
  }
  setQTerms(terms);
  renderPromptChips();
  loadImages();
}

function renderPromptChips() {
  const terms = qTerms();
  const pick = (sel, rawText) => {
    const host = $(sel);
    if (!host) return 0;
    const tags = splitPromptTags(rawText === "（无）" ? "" : rawText);
    host.innerHTML = "";
    for (const raw of tags) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = raw;
      b.title = terms.includes(raw)
        ? "取消按这个 tag 筛选"
        : "按这个 tag 搜索（Ctrl / Shift 点击可多选，多个 tag 是「同时包含」）";
      if (terms.includes(raw)) b.classList.add("on");
      b.addEventListener("click", (ev) =>
        togglePromptChip(raw, ev.ctrlKey || ev.metaKey || ev.shiftKey));
      host.appendChild(b);
    }
    return tags.length;
  };
  const nPos = pick("#lb-pos-chips", $("#lb-pos")?.textContent || "");
  const nNeg = pick("#lb-neg-chips", $("#lb-neg")?.textContent || "");
  const pos = $("#pb-pos-n");
  if (pos) pos.textContent = nPos ? `${nPos} 个` : "";
  const neg = $("#pb-neg-n");
  if (neg) neg.textContent = nNeg ? `${nNeg} 个` : "";
}

/* 提示词分区收起状态（默认展开，记忆在 localStorage） */
function bindPromptSections() {
  document.querySelectorAll(".pb-chev").forEach((btn) => {
    const sec = btn.closest(".pb-sec");
    btn.addEventListener("click", () => {
      sec.classList.toggle("closed");
      const open = !sec.classList.contains("closed");
      btn.setAttribute("aria-expanded", String(open));
      localStorage.setItem("texture.pb." + btn.dataset.sec, open ? "1" : "0");
    });
    if (localStorage.getItem("texture.pb." + btn.dataset.sec) === "0") {
      sec.classList.add("closed");
      btn.setAttribute("aria-expanded", "false");
    }
  });
}

/* 胶囊：一格 = 主体名 + 内容。展示态内容按逗号切词框（和提示词一致，点词框筛选），
   点「编辑」切换纯文本编辑态；改动 500ms 防抖自动保存。 */
const tagDoc = { fid: "", segs: [] };
let tagSaveTimer = null;
let tagTemplates = [];

async function loadTagTemplates() {
  try {
    tagTemplates = (await api("/api/tagdoc/templates")).templates || [];
  } catch { tagTemplates = []; }
  const sel = $("#tag-template");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">模板…</option>' + tagTemplates
    .map((t) => `<option value="${esc(t.name)}">${esc(t.name)} · ${t.segs.length} 格</option>`)
    .join("");
  if (cur) sel.value = cur;
}

function renderTagSegs() {
  const host = $("#tag-segs");
  if (!host) return;
  host.innerHTML = "";
  tagDoc.segs.forEach((seg, i) => {
    const box = document.createElement("article");
    box.className = "tagseg";
    box.innerHTML = `
      <header>
        <span class="tagseg-idx">${String(i + 1).padStart(2, "0")}</span>
        <input class="tagseg-k" placeholder="主体名" title="这一格的主题：人物 / 服装 / 画风…" aria-label="胶囊主体">
        <button class="tagseg-ico tagseg-edit" type="button" title="编辑内容（纯文本）"><i class="ic" data-ic="edit"></i></button>
        <button class="tagseg-ico tagseg-x" type="button" title="删除这一格"><i class="ic" data-ic="ashbin"></i></button>
      </header>
      <div class="tagseg-chips"></div>
      <textarea class="tagseg-v" hidden placeholder="这一格的内容，逗号分隔会切成词框" aria-label="胶囊内容"></textarea>`;
    const kEl = box.querySelector(".tagseg-k");
    const vEl = box.querySelector(".tagseg-v");
    const chipsEl = box.querySelector(".tagseg-chips");
    kEl.value = seg.k || "";
    vEl.value = seg.v || "";

    /* 展示态：内容切词框；点击 = 按这个词筛选（Ctrl/Shift = 多选 AND） */
    const renderChips = () => {
      chipsEl.innerHTML = "";
      const tags = splitPromptTags(seg.v);
      if (!tags.length) {
        const ghost = document.createElement("button");
        ghost.type = "button";
        ghost.className = "tagseg-ghost";
        ghost.textContent = "＋ 编辑内容";
        ghost.addEventListener("click", () => editBtn.click());
        chipsEl.appendChild(ghost);
        return;
      }
      const terms = qTerms();
      for (const raw of tags) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = raw;
        b.title = terms.includes(raw)
          ? "取消按这个词筛选"
          : "按这个词筛选（Ctrl / Shift 点击可多选）";
        if (terms.includes(raw)) b.classList.add("on");
        b.addEventListener("click", (ev) =>
          togglePromptChip(raw, ev.ctrlKey || ev.metaKey || ev.shiftKey));
        chipsEl.appendChild(b);
      }
    };
    renderChips();

    /* 编辑态：纯文本，失焦或再点 ✎ 提交回词框 */
    const editBtn = box.querySelector(".tagseg-edit");
    const setEdit = (on) => {
      vEl.hidden = !on;
      chipsEl.hidden = on;
      editBtn.classList.toggle("active", on);
      editBtn.title = on ? "完成（回到词框）" : "编辑内容（纯文本）";
      if (on) { vEl.focus(); }
      else { seg.v = vEl.value; tagTouch(); renderChips(); }
    };
    editBtn.addEventListener("click", () => setEdit(vEl.hidden));
    vEl.addEventListener("blur", () => setEdit(false));
    vEl.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") vEl.blur();
    });
    kEl.addEventListener("input", () => { seg.k = kEl.value; tagTouch(); });
    kEl.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      // 回车 = 再来一格，连续录入不用去点按钮
      if (ev.key === "Enter") { ev.preventDefault(); $("#tag-add-seg")?.click(); }
    });
    box.querySelector(".tagseg-x").addEventListener("click", () => {
      tagDoc.segs.splice(i, 1);
      renderTagSegs();
      tagTouch();
    });
    host.appendChild(box);
  });
  const empty = $("#tag-empty");
  if (empty) empty.hidden = tagDoc.segs.length > 0;
  const n = $("#tag-seg-n");
  if (n) n.textContent = tagDoc.segs.length ? `${tagDoc.segs.length} 格` : "";
}

function loadTagDoc(meta) {
  clearTimeout(tagSaveTimer);
  tagSaveTimer = null;
  tagDoc.fid = meta?.id || state.selected || "";
  tagDoc.segs = (meta?.tagdoc || []).map((s) => ({ k: s.k || "", v: s.v || "" }));
  renderTagSegs();
}

function tagTouch() {
  clearTimeout(tagSaveTimer);
  tagSaveTimer = setTimeout(() => { flushTagDoc(); }, 500);
}

async function flushTagDoc() {
  clearTimeout(tagSaveTimer);
  tagSaveTimer = null;
  if (!tagDoc.fid) return;
  const fid = tagDoc.fid;
  // 记住发出去的值：回填时只在本地没再被改过的情况下才写，
  // 否则请求飞行途中用户新敲的字会被旧响应盖回去。
  const sent = tagDoc.segs.map((s) => ({ k: s.k, v: s.v }));
  try {
    const r = await api("/api/tagdoc/" + encodeURIComponent(fid), {
      method: "PUT",
      body: { segs: tagDoc.segs },
    });
    if (tagDoc.fid === fid && r.segs.length === tagDoc.segs.length) {
      // 只回填字段值，不替换对象本身：
      // 页面上的输入框都闭包引用着 tagDoc.segs 里的这些对象，
      // 换掉对象会让正在编辑的那一格「失联」——新增一格时旧内容就会消失。
      r.segs.forEach((s, i) => {
        const cur = tagDoc.segs[i];
        if (!cur) return;
        if (cur.k === sent[i].k) cur.k = s.k;
        if (cur.v === sent[i].v) cur.v = s.v;
      });
    }
    const m = metaCache.get(fid);
    if (m) m.tagdoc = tagDoc.segs.map((s) => ({ k: s.k, v: s.v }));
  } catch (e) {
    toast("胶囊保存失败：" + String(e.message || e).slice(0, 60));
  }
}

/* ---------------- 选图弹窗：把胶囊模板套到别的图片上 ---------------- */

function pickImageTargets() {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.id = "app-pick";
    const chosen = new Set();
    let list = state.items || [];
    const close = (val) => {
      root.classList.add("closing");
      setTimeout(() => root.remove(), 120);
      resolve(val);
    };
    root.innerHTML = `
      <div class="ap-mask"></div>
      <div class="am-box ap-box">
        <p class="am-eyebrow">Pick Images</p>
        <p class="ap-title">挑几张图，把这个胶囊模板套上去</p>
        <input class="ap-search" type="search" placeholder="按文件名 / 标签 / 提示词搜索…" autocomplete="off">
        <div class="ap-grid"></div>
        <p class="ap-empty" hidden>没有匹配的图片</p>
        <div class="ap-foot">
          <span class="ap-count">已选 0 张</span>
          <div class="am-btns">
            <button class="ap-cancel" type="button">取消</button>
            <button class="am-ok" type="button">套用</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    const grid = root.querySelector(".ap-grid");
    const count = root.querySelector(".ap-count");
    const emptyEl = root.querySelector(".ap-empty");
    const okBtn = root.querySelector(".am-ok");

    const paint = () => {
      grid.innerHTML = "";
      emptyEl.hidden = list.length > 0;
      const frag = document.createDocumentFragment();
      for (const it of list) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ap-cell" + (chosen.has(it.id) ? " on" : "");
        b.title = it.name;
        b.innerHTML = `<img loading="lazy" decoding="async" src="/api/thumb/${it.id}?s=128" alt="">
          <span class="ap-cap"></span>`;
        b.querySelector(".ap-cap").textContent = it.name;
        b.onclick = () => {
          if (chosen.has(it.id)) chosen.delete(it.id); else chosen.add(it.id);
          b.classList.toggle("on", chosen.has(it.id));
          count.textContent = `已选 ${chosen.size} 张`;
          okBtn.disabled = !chosen.size;
        };
        frag.appendChild(b);
      }
      grid.appendChild(frag);
    };

    const search = root.querySelector(".ap-search");
    let st = null;
    search.addEventListener("input", () => {
      clearTimeout(st);
      const q = search.value.trim();
      st = setTimeout(async () => {
        if (!q) { list = state.items || []; paint(); return; }
        try {
          const data = await api("/api/images?q=" + encodeURIComponent(q));
          list = data.items || [];
          paint();
        } catch { /* 搜索失败就保持原列表 */ }
      }, 220);
    });

    okBtn.disabled = true;
    paint();
    root.querySelector(".ap-cancel").onclick = () => close([]);
    okBtn.onclick = () => close([...chosen]);
    root.querySelector(".ap-mask").onclick = () => close([]);
    root.onkeydown = (e) => { if (e.key === "Escape") close([]); };
    search.focus();
  });
}

/* 把一份模板套到若干张图上（只补分格名，内容各图自己写） */
async function applyTemplateTo(ids, name) {
  if (!name) { toast("先选一个模板"); return; }
  if (!ids.length) { toast("还没有选中图片"); return; }
  try {
    await flushTagDoc();     // 先把手上没存完的编辑落盘，别被模板盖掉
    const r = await api("/api/tagdoc/apply",
      { method: "POST", body: { ids, template: name, mode: "merge" } });
    for (const fid of ids) {
      const m = metaCache.get(fid);
      if (m && r.docs[fid]) m.tagdoc = r.docs[fid];
    }
    if (state.selected && r.docs[state.selected]) {
      const server = r.docs[state.selected];
      if (server.length === tagDoc.segs.length) {
        // 数量一致就原地改字段，别换对象（换对象会让正在编辑的那格失联）
        server.forEach((s, i) => {
          tagDoc.segs[i].k = s.k || "";
          tagDoc.segs[i].v = s.v || "";
        });
      } else {
        tagDoc.segs = server.map((s) => ({ k: s.k || "", v: s.v || "" }));
      }
      renderTagSegs();
    }
    toast(`已给 ${ids.length} 张图片套上「${name}」的胶囊`);
  } catch (e) {
    toast("应用失败：" + String(e.message || e).slice(0, 60));
  }
}

/* ---------------- 节点图（ComfyUI） ---------------- */

const graphCache = new Map();
let graphShown = null;   // 当前渲染的节点图数据

function loadGraphTab(meta, fid) {
  const btn = $("#tab-btn-graph");
  const isComfy = meta && meta.source === "comfyui";
  btn.hidden = !isComfy;
  if (!isComfy) {
    // 切走时不要把"节点图"页留在前台
    if (!$("#tab-graph").hidden) showTab("params");
    graphShown = null;
    return;
  }
  renderGraph(fid);
}

function showTab(name) {
  document.querySelectorAll(".lb-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-body").forEach((b) => (b.hidden = true));
  const el = $("#tab-" + name);
  if (el) el.hidden = false;
  if (name === "graph") {
    if (graphShown) {
      // 页签从隐藏变为可见后才能量到宽度，这里重算一次比例
      $("#graph-view").innerHTML = graphSVG(graphShown);
      bindGraphPreview($("#graph-view"));
    } else {
      // 没有节点图时也要给人一句话，避免一整片空白
      const empty = $("#graph-empty");
      if (!empty.textContent.trim()) {
        empty.textContent = state.selected
          ? "这张图没有可用的节点图 —— 节点图只对 ComfyUI 生成的图片有效。"
          : "选中一张图片后，这里显示它的 ComfyUI 节点图。";
      }
      empty.hidden = false;
    }
  }
  if (name === "prompt") loadTagTemplates();
}

async function renderGraph(fid) {
  const view = $("#graph-view");
  const empty = $("#graph-empty");
  const note = $("#graph-note");
  if (!fid) return;

  let data = graphCache.get(fid);
  if (!data) {
    view.innerHTML = '<div class="graph-loading">读取节点图…</div>';
    try {
      data = await api("/api/graph/" + encodeURIComponent(fid));
    } catch (e) {
      view.innerHTML = "";
      empty.hidden = false;
      empty.textContent = "读取节点图失败：" + (e && e.message ? e.message : e);
      note.textContent = "";
      return;
    }
    graphCache.set(fid, data);
  }
  if (state.selected !== fid) return;   // 用户已经切到别的图
  graphShown = data.ok ? data : null;

  if (!data.ok) {
    view.innerHTML = "";
    empty.hidden = false;
    empty.textContent = data.note || "这张图里没有可用的节点图。";
    note.textContent = "";
    return;
  }

  empty.hidden = true;
  const wide = graphIsWide(data);
  note.textContent = `${data.nodes.length} 个节点 │ ${data.links.length} 条连线 │ ` +
    (data.source === "workflow" ? "按原工作流排版" : "自动排版") +
    (wide ? " │ 缩略图" : "");
  view.innerHTML = graphSVG(data);
  bindGraphPreview(view);
}

/* 节点图预览：装得下就按原样画（文字可读、必要时横向滚动）；
   装不下就画成缩略图——只留方块，名字放到悬停提示里，形状和流程仍看得出。 */
function graphSVG(data) {
  const nodes = data.nodes || [];
  if (!nodes.length) return "";
  const links = data.links || [];
  const pad = 16;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const vw = bw + pad * 2, vh = bh + pad * 2;

  const view = $("#graph-view");
  const avail = (view && view.clientWidth) || 320;
  const fit = avail / vw;
  const mini = fit < 0.5;                       // 太小就不画字，改缩略图
  const scale = mini ? fit : Math.max(0.62, Math.min(1, fit));

  const pos = new Map(nodes.map((n) => [n.id, n]));
  const paths = [];
  for (const l of links) {
    const a = pos.get(l.from), b = pos.get(l.to);
    if (!a || !b) continue;
    const ac = { x: a.x - minX + pad + a.w / 2, y: a.y - minY + pad + a.h / 2 };
    const bc = { x: b.x - minX + pad + b.w / 2, y: b.y - minY + pad + b.h / 2 };
    const h = Math.max(20, Math.abs(bc.x - ac.x) * 0.45);
    paths.push(`<path class="g-edge" d="M ${ac.x} ${ac.y} C ${ac.x + h} ${ac.y}, ` +
      `${bc.x - h} ${bc.y}, ${bc.x} ${bc.y}"></path>`);
  }

  const boxes = nodes.map((n) => {
    const x = n.x - minX + pad, y = n.y - minY + pad;
    const w = Math.max(24, n.w), h = Math.max(16, n.h);
    const label = esc(n.title || n.type || "Node");
    const tip = esc(`${n.title || n.type || "Node"}${n.type && n.type !== n.title ? " · " + n.type : ""}`);
    const muted = n.muted ? " muted" : "";
    if (mini) {
      return `<g class="g-node mini${muted}"><title>${tip}</title>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}"></rect></g>`;
    }
    const cls = n.type && n.type !== n.title ? esc(n.type) : "";
    const sub = cls && w > 90
      ? `<text class="g-cls" x="${x + 6}" y="${y + h - 6}">${cls}</text>` : "";
    return `<g class="g-node${muted}"><title>${tip}</title>` +
      `<rect x="${x}" y="${y}" width="${w}" height="${h}"></rect>` +
      `<text class="g-title" x="${x + 6}" y="${y + 15}">${label}</text>${sub}</g>`;
  }).join("");

  const cls = "graph-svg" + (mini ? " mini" : "");
  return `<svg class="${cls}" viewBox="0 0 ${Math.round(vw)} ${Math.round(vh)}"` +
    ` width="${Math.round(vw * scale)}" height="${Math.round(vh * scale)}"` +
    ` role="img" aria-label="ComfyUI 节点图：${nodes.length} 个节点、${links.length} 条连线">` +
    `<g class="g-edges">${paths.join("")}</g>${boxes}</svg>`;
}

/* 这张图是否只能画成缩略图（装不下就缩到 50% 以下） */
function graphIsWide(data) {
  const nodes = data.nodes || [];
  if (!nodes.length) return false;
  let minX = Infinity, maxX = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x + n.w); }
  const view = $("#graph-view");
  const avail = (view && view.clientWidth) || 320;
  return (maxX - minX + 32) > avail / 0.5;
}

/* 悬停节点时高亮它的连线（纯 CSS 做不到跨元素，用一点脚本） */
function bindGraphPreview(view) {
  const svg = view.querySelector("svg");
  if (!svg) return;
  svg.querySelectorAll(".g-node").forEach((g) => {
    g.addEventListener("pointerenter", () => g.classList.add("hot"));
    g.addEventListener("pointerleave", () => g.classList.remove("hot"));
  });
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

function setNav(open, save = true, autoPin = true) {
  document.body.classList.toggle("nav-closed", !open);
  if (save) localStorage.setItem("texture.nav", open ? "1" : "0");
  // 默认打开即固定：展开侧栏就等于把它钉住，不会再因为选文件夹自动收起
  if (open && autoPin) localStorage.setItem("texture.navPin", "1");
  refreshNavPin();
}

const navPinned = () => localStorage.getItem("texture.navPin") !== "0";

/* 图钉并进「侧栏」开关本身：图标亮黄 = 已固定（默认） */
function refreshNavPin() {
  const btn = $("#nav-toggle");
  if (!btn) return;
  const open = !document.body.classList.contains("nav-closed");
  const on = open && navPinned();
  btn.classList.toggle("pinned", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = !open ? "打开侧栏 (N)"
    : on ? "侧栏已固定：选文件夹不会自动收起（点一下收起，Alt+点击可取消固定）"
    : "侧栏未固定：选文件夹后会自动收起（Alt+点击改回固定）";
}

function bindNav() {
  // 宽屏默认展开；窄屏（浮层会挡住内容）默认收起。用户手动切换过就以记忆为准。
  const saved = localStorage.getItem("texture.nav");
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  const open = saved === null ? !narrow : saved !== "0";
  setNav(open, false);
  $("#nav-toggle").addEventListener("click", (ev) => {
    if (ev.altKey || ev.shiftKey) {          // Alt/Shift 点击 = 只切固定
      localStorage.setItem("texture.navPin", navPinned() ? "0" : "1");
      refreshNavPin();
      toast(navPinned() ? "侧栏已固定" : "侧栏取消固定：选文件夹后自动收起");
      return;
    }
    setNav(document.body.classList.contains("nav-closed"));
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

/* ---------------- 左右面板拖拽调宽 ---------------- */

function bindPanelResize() {
  const root = document.documentElement;
  const savedNav = Number(localStorage.getItem("texture.navWidth"));
  const savedInsp = Number(localStorage.getItem("texture.inspWidth"));
  if (savedNav >= 160) {
    root.style.setProperty("--nav-w", Math.min(savedNav, Math.max(160, innerWidth * 0.4)) + "px");
  }
  if (savedInsp >= 240) {
    root.style.setProperty("--insp-w", Math.min(savedInsp, Math.max(240, innerWidth * 0.52)) + "px");
  }

  const drag = (ev, kind) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const start = kind === "nav"
      ? $("#sidebar").getBoundingClientRect().width
      : $("#inspector").getBoundingClientRect().width;
    let raf = 0;
    const apply = (width) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (kind === "nav") {
          root.style.setProperty("--nav-w", width + "px");
          localStorage.setItem("texture.navWidth", String(Math.round(width)));
        } else {
          root.style.setProperty("--insp-w", width + "px");
          localStorage.setItem("texture.inspWidth", String(Math.round(width)));
        }
        window.dispatchEvent(new Event("resize"));
      });
    };
    document.body.classList.add("panel-resizing");
    const onMove = (e) => {
      const dx = e.clientX - startX;
      if (kind === "nav") {
        const max = Math.min(420, innerWidth * 0.4);
        apply(Math.max(160, Math.min(max, start + dx)));
      } else {
        const max = Math.min(620, innerWidth * 0.52);
        apply(Math.max(240, Math.min(max, start - dx)));
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("panel-resizing");
      if (kind === "nav" && document.body.classList.contains("nav-closed")) setNav(true);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  $("#sidebar-resizer")?.addEventListener("mousedown", (ev) => drag(ev, "nav"));
  $("#insp-resizer")?.addEventListener("mousedown", (ev) => drag(ev, "insp"));
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

  $("#f-sort").addEventListener("change", (ev) => { state.filter.sort = ev.target.value; loadImages(); });
  const subBtn = $("#f-subfolders");
  const syncSubBtn = () => {
    subBtn.classList.toggle("active", state.filter.subfolders);
    subBtn.setAttribute("aria-pressed", String(state.filter.subfolders));
  };
  syncSubBtn();
  subBtn.addEventListener("click", () => {
    state.filter.subfolders = !state.filter.subfolders;
    localStorage.setItem("texture.gallerySubfolders", state.filter.subfolders ? "1" : "0");
    syncSubBtn();
    loadImages(); loadFacets();
  });
  $("#f-fav").addEventListener("change", (ev) => { state.filter.fav = ev.target.checked; loadImages(); loadFacets(); });

  $("#btn-clear-filter").addEventListener("click", () => {
    state.filter = { q: "", family: "", sort: "time-desc",
                     tag: "", tags: [], fav: false, root: "", dir: "",
                     subfolders: state.filter.subfolders };
    search.value = "";
    clearBtn.hidden = true;
    $("#f-fav").checked = false;
    renderPromptChips();
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
    const stat = $("#stat");
    if (stat) stat.textContent = "扫描中…";
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
  $("#insp-toggle").addEventListener("click", (ev) => {
    if (ev.altKey || ev.shiftKey) {
      localStorage.setItem("texture.inspPin", inspPinned() ? "0" : "1");
      refreshInspPin();
      toast(inspPinned() ? "信息栏已固定" : "信息栏取消固定：放大看图会自动收起");
      return;
    }
    setInspector(!$("#main").classList.contains("insp-open"));
  });
  $("#insp-node-text").addEventListener("input", (ev) => onBoardNodeInput(ev.target.value));
  $("#insp-node-dup").addEventListener("click", () => boardNodeEdit?.opts.onDuplicate?.());
  $("#insp-node-del").addEventListener("click", () => boardNodeEdit?.opts.onDelete?.());

  /* 标题即改名入口：回车提交，Esc 撤回，失焦也提交 */
  const nameEl = $("#lb-name");
  nameEl.addEventListener("focus", () => {
    if (nameEl.readOnly) return;
    const dot = nameEl.value.lastIndexOf(".");
    const end = dot > 0 ? dot : nameEl.value.length;
    requestAnimationFrame(() => {
      try { nameEl.setSelectionRange(0, end); } catch { /* ignore */ }
    });
  });
  nameEl.addEventListener("keydown", (ev) => {
    if (nameEl.readOnly) return;
    if (ev.key === "Enter") { ev.preventDefault(); nameEl.blur(); }
    else if (ev.key === "Escape") {
      ev.preventDefault();
      nameEl.value = nameEl.dataset.base || "";
      nameEl.blur();
    }
  });
  nameEl.addEventListener("blur", async () => {
    if (nameEl.readOnly) return;
    const base = nameEl.dataset.base || "";
    const next = nameEl.value.trim();
    if (!next || next === base) { nameEl.value = base; return; }
    const id = currentFileId();
    if (!id) { nameEl.value = base; return; }
    try {
      const r = await api("/api/rename/" + encodeURIComponent(id),
        { method: "POST", body: { name: next, path: currentMeta?.file?.path || "" } });
      nameEl.value = r.name;
      nameEl.dataset.base = r.name;
      const it = state.items.find((x) => x.id === id);
      if (it) {
        it.name = r.name;
        const cell = document.querySelector(`.cell[data-id="${id}"]`);
        if (cell) { cell.title = r.name; cell.setAttribute("aria-label", r.name); }
      }
      const m = metaCache.get(id);
      if (m && m.file) {
        m.file.name = r.name;
        m.file.path = m.file.path.replace(/[^\\/]+$/, r.name);
      }
      const info = $("#lb-fileinfo");
      if (info && m?.file?.path) {
        info.textContent = info.textContent.replace(/^.*?(?= · )/, m.file.path);
        nameEl.title = m.file.path;
      }
      toast("已重命名为 " + r.name);
    } catch (e) {
      nameEl.value = base;
      toast("重命名失败：" + String(e.message || e).slice(0, 80));
    }
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
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  });

  /* 提示词分区 + 胶囊 */
  bindPromptSections();
  loadTagTemplates();
  $("#tag-add-seg").addEventListener("click", () => {
    tagDoc.segs.push({ k: "", v: "" });
    renderTagSegs();
    const boxes = document.querySelectorAll("#tag-segs .tagseg");
    boxes[boxes.length - 1]?.scrollIntoView({ block: "nearest" });
    const inputs = document.querySelectorAll("#tag-segs .tagseg-k");
    inputs[inputs.length - 1]?.focus();
    tagTouch();
  });
  $("#tag-apply").addEventListener("click", async () => {
    const name = $("#tag-template").value;
    if (!name) { toast("先在左边选一个模板"); return; }
    const ids = state.selection.size ? [...state.selection]
      : (state.selected ? [state.selected] : []);
    if (!ids.length) { toast("还没有选中图片"); return; }
    await applyTemplateTo(ids, name);
  });
  $("#tag-apply-to").addEventListener("click", async () => {
    const name = $("#tag-template").value;
    if (!name) { toast("先在左边选一个模板"); return; }
    const ids = await pickImageTargets();
    if (!ids.length) return;
    await applyTemplateTo(ids, name);
  });
  $("#tag-save-tpl").addEventListener("click", async () => {
    if (!tagDoc.segs.length) { toast("当前没有胶囊可存"); return; }
    const dft = tagDoc.segs.find((s) => s.k)?.k || "我的胶囊";
    const name = (await appPrompt("模板名称（只存分格名，不含内容）：", dft)) || "";
    if (!name.trim()) return;
    try {
      await api("/api/tagdoc/templates", {
        method: "POST",
        body: { name: name.trim(), segs: tagDoc.segs },
      });
      await loadTagTemplates();
      $("#tag-template").value = name.trim();
      toast("已存为模板「" + name.trim() + "」（只记分格名）");
    } catch (e) {
      toast("保存模板失败：" + String(e.message || e).slice(0, 60));
    }
  });
  $("#tag-del-tpl").addEventListener("click", async () => {
    const name = $("#tag-template").value;
    if (!name) { toast("先选中要删除的模板"); return; }
    if (!(await appConfirm(`删除模板「${name}」？\n（只删模板，已写进图片的胶囊不受影响）`))) return;
    await api("/api/tagdoc/templates?name=" + encodeURIComponent(name), { method: "DELETE" });
    await loadTagTemplates();
    $("#tag-template").value = "";
    toast("已删除模板");
  });
  $("#graph-to-board").addEventListener("click", async () => {
    const fid = currentFileId();
    if (!fid) return;
    if (typeof window.addGraphToBoard !== "function") { toast("画板尚未就绪"); return; }
    const btn = $("#graph-to-board");
    btn.setAttribute("aria-busy", "true");
    const n = await window.addGraphToBoard(fid);
    btn.removeAttribute("aria-busy");
    if (n) btn.textContent = "已送入";
    setTimeout(() => { btn.textContent = "送入画板"; }, 1800);
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
  applyTheme(localStorage.getItem("texture.theme") || "light");
  $("#set-theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    toast(next === "light" ? "已切换到浅色主题" : "已切换到深色主题");
  });
  $("#hk-reset-all")?.addEventListener("click", () => Hotkeys.resetAll());
  $("#set-shortcuts").addEventListener("click", () => { Hotkeys.renderPanel(); $("#shortcuts").hidden = false; });

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
    if (!inField && Hotkeys.match(ev, "gallery.enter") && state.selected) openLightbox(state.selected);
    if (!inField && Hotkeys.match(ev, "gallery.all")) {
      ev.preventDefault();
      state.selection = new Set(state.items.map((x) => x.id));
      document.querySelectorAll(".cell").forEach((c) => c.classList.add("picked"));
      syncSelectionBar();
    }
    if (!inField && Hotkeys.match(ev, "gallery.panel")) { Hotkeys.renderPanel(); $("#shortcuts").hidden = !$("#shortcuts").hidden; }
    if (!inField && Hotkeys.match(ev, "gallery.info")) {
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
    if (!inField && Hotkeys.match(ev, "gallery.nav")) {
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
  /* 离开画板时把信息栏还给图库：否则会残留画布节点编辑面板 */
  if (view !== "board") {
    window.hideBoardNodeInspector?.();
    restoreGalleryInspector();
  }
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
bindPanelResize();
bindLbZoom();
bindSectionCollapse();
loadImages();
loadSidebar();
let masonryTimer = null;
new ResizeObserver(() => {
  clearTimeout(masonryTimer);
  masonryTimer = setTimeout(layoutMasonry, 80);
}).observe($("#grid"));