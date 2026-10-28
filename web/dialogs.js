/* 双模式弹窗：原生窗口走 pywebview 桥，浏览器走自定义模态（照手册 §7.3） */
"use strict";

const customModal = (() => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let root = null;
  function open({ body, input = false, value = "", okText = "确定", danger = false }) {
    return new Promise((resolve) => {
      let closed = false;
      const done = (v) => {
        if (closed) return;
        closed = true;
        // 退场：120ms 淡出后隐藏（与入场 200ms 对称的一半）
        root.classList.add("closing");
        setTimeout(() => {
          root.classList.remove("closing");
          root.innerHTML = "";
          root.style.display = "none";   // 容器也隐藏，否则 fixed 遮罩挡住页面
          resolve(v);
        }, 120);
      };
      if (!root) { root = document.createElement("div"); root.id = "app-modal"; document.body.appendChild(root); }
      root.classList.remove("closing");
      root.style.display = "";
      root.innerHTML = `
        <div class="am-mask"></div>
        <div class="am-box">
          <p class="am-eyebrow">${danger ? "Confirm" : input ? "Input" : "Notice"}</p>
          <div class="am-body">${esc(body)}</div>
          ${input ? `<input class="am-input" value="${esc(value)}">` : ""}
          <div class="am-btns">
            <button class="am-cancel" type="button">取消</button>
            <button class="am-ok${danger ? " danger" : ""}" type="button">${okText}</button>
          </div>
        </div>`;
      root.querySelector(".am-ok").onclick = () =>
        done(input ? root.querySelector(".am-input").value : true);
      root.querySelector(".am-cancel").onclick = () => done(input ? "" : false);
      root.querySelector(".am-mask").onclick = () => done(input ? value : false);
      const inp = root.querySelector(".am-input");
      if (inp) { inp.focus(); inp.select(); inp.onkeydown = (e) => { if (e.key === "Enter") root.querySelector(".am-ok").click(); }; }
      root.onkeydown = (e) => { if (e.key === "Escape") root.querySelector(".am-cancel").click(); };
    });
  }
  return {
    confirm: (m) => open({ body: m, danger: true }),
    prompt: (m, v = "") => open({ body: m, input: true, value: v }),
    alert: (m) => open({ body: m, okText: "知道了" }),
  };
})();

function nativeReady(timeout = 3000) {
  return new Promise((resolve) => {
    if (window.pywebview && window.pywebview.api) return resolve(true);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (window.pywebview && window.pywebview.api) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(false); }
    }, 100);
  });
}

async function pickFolder() {
  if (await nativeReady()) {
    try {
      // 原生对话框可能挂起（弹在窗口后面/线程异常），限时兜底
      const r = await Promise.race([
        window.pywebview.api.pick_folder(),
        new Promise((res) => setTimeout(() => res("__timeout__"), 90000)),
      ]);
      if (r === "__timeout__") { /* 走下面的手动输入 */ }
      else if (r) return r;
      else return "";   // 用户在原生对话框里点了取消
    } catch { /* 原生调用异常 → 走手动输入 */ }
  }
  return (await customModal.prompt(
    "输入图片文件夹的绝对路径：\n（例如 D:\\outputs 或 D:\\ComfyUI\\output）", "")) || "";
}
const appConfirm = (m) => customModal.confirm(m);   // 统一走自定义模态，双模式一致
const appPrompt = (m, v) => customModal.prompt(m, v);
const appAlert = (m) => customModal.alert(m);
