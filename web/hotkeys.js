/* 可改键的快捷键系统：中央注册表 + 匹配 + 面板 + localStorage 持久化。
   app.js / board.js 的键盘处理一律走 Hotkeys.match(ev, id)，不再硬编码键位。 */
"use strict";

const Hotkeys = (() => {
  const DEFS = [
    { id: "gallery.panel", label: "快捷键面板",           def: { key: "?" }, scope: "any" },
    { id: "gallery.info",  label: "信息栏 开/收",         def: { key: "i" }, scope: "gallery" },
    { id: "gallery.nav",   label: "侧栏 开/收",           def: { key: "n" }, scope: "gallery" },
    { id: "gallery.all",   label: "全选当前结果",         def: { key: "a", ctrl: true }, scope: "gallery" },
    { id: "gallery.enter", label: "放大当前选中",         def: { key: "Enter" }, scope: "gallery" },
    { id: "board.del",     label: "画板：删除选中",       def: { key: "Delete" }, scope: "board" },
    { id: "board.dup",     label: "画板：复制选中",       def: { key: "d", ctrl: true }, scope: "board" },
    { id: "board.text",    label: "画板：新建文本",       def: { key: "t" }, scope: "board" },
    { id: "board.md",      label: "画板：新建 Markdown",  def: { key: "m" }, scope: "board" },
    { id: "board.group",   label: "画板：新建分组",       def: { key: "g" }, scope: "board" },
    { id: "board.fit",     label: "画板：适应全部",       def: { key: "f" }, scope: "board" },
    { id: "board.z100",    label: "画板：缩放 100%",      def: { key: "0" }, scope: "board" },
    { id: "board.front",   label: "画板：移到最前",       def: { key: "]" }, scope: "board" },
    { id: "board.back",    label: "画板：移到最后",       def: { key: "[" }, scope: "board" },
  ];

  function defaults() {
    return Object.fromEntries(DEFS.map((d) => [d.id, { ...d.def }]));
  }
  function load() {
    try {
      return { ...defaults(), ...JSON.parse(localStorage.getItem("texture.hotkeys") || "{}") };
    } catch {
      return defaults();
    }
  }
  let map = load();

  function save() {
    try { localStorage.setItem("texture.hotkeys", JSON.stringify(map)); } catch { /* 忽略 */ }
  }
  function label(b) {
    if (!b || !b.key) return "未设置";
    const k = b.key.length === 1 ? b.key.toUpperCase() : b.key;
    return (b.ctrl ? "Ctrl+" : "") + (b.alt ? "Alt+" : "") + (b.shift ? "Shift+" : "") + k;
  }
  function match(ev, id) {
    const b = map[id];
    if (!b || !b.key) return false;
    if ((ev.ctrlKey || ev.metaKey) !== !!b.ctrl) return false;
    if (ev.altKey !== !!b.alt) return false;
    if (b.key.length > 1 && ev.shiftKey !== !!b.shift) return false;   // 单字符忽略 Shift（大小写）
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    return k === b.key.toLowerCase();
  }
  function setBinding(id, b) {
    map[id] = b;
    save();
    renderPanel();
  }
  function reset(id) {
    const d = DEFS.find((x) => x.id === id);
    if (d) { map[id] = { ...d.def }; save(); renderPanel(); }
  }
  function resetAll() {
    map = defaults();
    save();
    renderPanel();
    toast("快捷键已全部恢复默认");
  }

  /* 面板渲染 + 捕获改键 */
  function renderPanel() {
    const host = document.getElementById("hk-list");
    if (!host) return;
    host.innerHTML = "";
    for (const d of DEFS) {
      const row = document.createElement("div");
      row.className = "hk-row";
      row.innerHTML = `<span class="hk-label">${d.label}</span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hk-key";
      btn.textContent = label(map[d.id]);
      btn.title = "点击后按新的组合键；Esc 取消";
      btn.addEventListener("click", () => capture(d, btn));
      row.appendChild(btn);
      const rst = document.createElement("button");
      rst.type = "button";
      rst.className = "hk-reset";
      rst.title = "恢复默认";
      rst.textContent = "↺";
      rst.addEventListener("click", () => reset(d.id));
      row.appendChild(rst);
      host.appendChild(row);
    }
  }

  function capture(def, btn) {
    btn.classList.add("capturing");
    btn.textContent = "按下新键…";
    const onKey = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener("keydown", onKey, true);
      btn.classList.remove("capturing");
      if (ev.key === "Escape") { renderPanel(); return; }   // Esc 取消，不作绑定
      if (["Shift", "Control", "Alt", "Meta"].includes(ev.key)) { renderPanel(); return; }
      const b = {
        key: ev.key,
        ctrl: ev.ctrlKey || ev.metaKey,
        alt: ev.altKey,
        shift: ev.key.length > 1 ? ev.shiftKey : false,
      };
      const clash = DEFS.find((x) => x.id !== def.id && label(map[x.id]) === label(b));
      setBinding(def.id, b);
      toast(clash
        ? `已设置：${def.label} = ${label(b)}（与「${clash.label}」相同，注意区分作用范围）`
        : `已设置：${def.label} = ${label(b)}`);
    };
    document.addEventListener("keydown", onKey, true);
  }

  return { match, label, renderPanel, resetAll, DEFS };
})();
