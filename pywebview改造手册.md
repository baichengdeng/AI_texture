# Texture — pywebview 桌面化改造手册

> **给执行本任务的 AI**：本文自包含，不依赖任何历史对话。动手前先通读 §1 背景、§3 方案、§5 已知坑、§8 禁止事项、§9 验收清单。遇到与手册冲突的实际情况：小偏差（命名、样式细节）可自行决定；大偏差（方案变更）停下来向用户报告，不要擅自换技术栈。
>
> 基准代码状态：2026-10-25，`python tests/test_readers.py` 43/43 通过。

---

## 1. 项目背景（自包含）

**Texture** 是一个本地优先的 AI 生成图片元数据管理软件：Python (FastAPI) 后端 + 原生 JS 前端（无构建、无 CDN）。当前形态是「本地 Web 应用」——`run.py` 启动 uvicorn（默认 `http://127.0.0.1:8770`）并自动打开系统浏览器。

**本次任务**：把「浏览器窗口」换成「原生桌面窗口」（pywebview / WebView2），后端、前端逻辑、解析器全部保留不动。

### 文件地图

| 文件 | 职责 | 本次是否改动 |
|---|---|---|
| `run.py` | 启动入口（argparse + uvicorn + 开浏览器） | **重写（核心）** |
| `app/main.py` | FastAPI 路由 + 静态挂载 `web/` | 不动（可选 §7.2 两处小修） |
| `app/store.py` | SQLite（根目录/收藏/标签/画板/缓存） | 不动 |
| `app/scanner.py` | 文件夹扫描 + 元数据缓存 | 不动 |
| `app/metadata/*` | 各平台元数据解析器 | **禁止改动** |
| `app/export.py` | A1111 文本 / workflow JSON / 画板 HTML 导出 | 不动 |
| `web/index.html` | 页面结构 | 可不改（弹窗建议 JS 注入） |
| `web/app.js` | 图库：网格/灯箱/收藏/标签/过滤 | **改 3 处弹窗** |
| `web/board.js` | 无限画板：平移缩放/拖放/持久化 | **改 2 处弹窗 + 自动保存** |
| `web/style.css` | 样式 | 加弹窗样式 |
| `tests/test_readers.py` | 解析器自测脚本（非 pytest） | 不动；跑通作为回归标准 |
| `requirements.txt` | fastapi/uvicorn/pillow/numpy/piexif | **加 pywebview** |
| `README.md` / `需求表.md` | 文档 | 更新运行说明 / NFR-4 |

### 关键现状事实（写代码前须知）

- 服务绑定 `127.0.0.1:8770`（main.py 的 `run.py` 默认值），禁止改成 0.0.0.0。
- 前端通过相对路径 `fetch("/api/...")` 访问后端，`web/` 由 StaticFiles 挂载在 `/`——pywebview 窗口指向同一 URL 后这一切照旧。
- 前端用了 5 处浏览器原生弹窗（pywebview 里全部不可用，见 §5.1）：
  - `web/app.js` **添加文件夹**按钮处理器（约 248 行）：`prompt("输入图片文件夹的绝对路径…")`，失败分支有 `alert("添加失败：" + e.message)`
  - `web/app.js` 根目录列表 ✕ 删除（约 128 行）：`confirm("从图库移除该文件夹？…")`
  - `web/board.js` **新画板**按钮（约 167 行）：`prompt("画板名称：", 默认名)`
  - `web/board.js` **删除画板**按钮（约 174 行）：`confirm("删除画板…？")`
  - （行号会随编辑漂移，用按钮 id / 按钮文案定位：`#btn-add-root`、`rm.addEventListener`、`#board-new`、`#board-delete`）
- `web/board.js` 末尾有 `beforeunload → fetch 保存`，浏览器里就不可靠，原生窗口关闭时更不可靠 → §7.1 用防抖自动保存解决。
- 环境已具备：Windows 11 23H2（WebView2 Runtime 预装）、Python 3.15、fastapi/uvicorn/pillow/numpy/piexif 已装。

---

## 2. 任务目标与非目标

**目标（P0）**
1. `python run.py` 打开一个标题为「Texture」的原生桌面窗口（无地址栏、无浏览器标签页），内嵌现有 Web UI，功能与浏览器模式完全一致。
2. 关闭窗口 → 进程干净退出（uvicorn 停止、端口释放、无残留 python 进程）。
3. 5 处原生弹窗全部替换为双模式可用的实现（§7.3），其中「添加文件夹」在原生模式用系统文件夹选择对话框。
4. `python run.py --web` 保留旧行为（自动开浏览器），作为调试回退。
5. `python tests/test_readers.py` 仍然 43/43 通过；`requirements.txt` 加入 pywebview。

**非目标（本次不做）**
- 不打包 exe（P2 见 §7.4，用户未要求可跳过）。
- 不改前端框架、不引入构建工具、不加 CDN。
- 不动任何元数据解析逻辑。
- 不做窗口图标、全局快捷键、系统托盘。

---

## 3. 技术方案（已定，不要换路线）

```
┌─ python 进程 ────────────────────────────────┐
│  主线程:   webview.start()  ← 原生窗口(WebV2) │
│  后台线程: uvicorn.Server (127.0.0.1:port)    │
└──────────────────────────────────────────────┘
```

- **pywebview 5.x**（Windows 默认走 WebView2/Edge Chromium，经由 pythonnet）。窗口指向 `http://127.0.0.1:{port}`，即现有 FastAPI 服务——**不用** pywebview 内置的 WSGI http_server，继续用 uvicorn 线程，行为与现在完全一致且可控。
- **启停顺序**：先起 uvicorn 并确认 `server.started`，再 `webview.start()`（否则窗口可能加载出错误页）；窗口关闭后置 `server.should_exit = True` 让 uvicorn 优雅停止。
- **原生能力桥**：`webview.create_window(js_api=...)` 暴露给前端 `window.pywebview.api`。本次只需要一个方法：`pick_folder()`。
- **浏览器弹窗替代**：JS 注入的 Promise 化模态框（`appConfirm/appPrompt/appAlert`），双模式通用；仅文件夹选择按模式分流（原生选择器 vs `prompt()` 回退）。

`requirements.txt` 追加一行：`pywebview>=5.1,<6`（pythonnet/clr-loader 会作为 Windows 依赖自动带入，不要手工加）。

---

## 4. `run.py` 参考实现（P0，可直接采用或微调）

```python
"""Texture 启动入口。

用法：
    python run.py                # 原生桌面窗口（pywebview/WebView2）
    python run.py --web          # 浏览器模式（旧行为，调试用）
    python run.py --port 9000    # 指定端口
    python run.py --debug        # WebView2 开发者工具 + uvicorn info 日志
"""
import argparse
import threading
import time

import uvicorn


def start_server(port: int, log_level: str = "warning") -> uvicorn.Server:
    """后台线程启动 uvicorn，返回可控制停止的 Server 对象。"""
    config = uvicorn.Config("app.main:app", host="127.0.0.1", port=port,
                            log_level=log_level)
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):  # 最多等 5s，避免窗口先加载出错误页
        if server.started:
            return server
        time.sleep(0.05)
    raise RuntimeError(f"服务启动失败：127.0.0.1:{port} 无法监听（端口被占用？）")


def run_web(port: int):
    """浏览器模式（保留旧行为）。"""
    import webbrowser
    threading.Timer(1.5, webbrowser.open, args=(f"http://127.0.0.1:{port}",)).start()
    print(f"Texture 已启动 → http://127.0.0.1:{port}   (Ctrl+C 退出)")
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="warning")


class NativeApi:
    """暴露给前端 window.pywebview.api 的原生能力（方法在后台线程被调用）。"""

    def pick_folder(self):
        import webview
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        # 返回 str 列表或 None；约定返回首个路径字符串，取消返回 ""
        return result[0] if result else ""


def run_native(port: int, debug: bool):
    import webview
    server = start_server(port, "info" if debug else "warning")
    webview.create_window(
        "Texture", f"http://127.0.0.1:{port}",
        js_api=NativeApi(), width=1400, height=900, min_size=(960, 640),
    )
    try:
        webview.start(debug=debug)  # 阻塞至窗口关闭
    finally:
        server.should_exit = True
        time.sleep(0.2)


def main():
    ap = argparse.ArgumentParser(description="Texture — AI 图片元数据管理")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--web", action="store_true", help="浏览器模式（调试用）")
    ap.add_argument("--debug", action="store_true", help="WebView2 开发者工具")
    args = ap.parse_args()
    if args.web:
        run_web(args.port)
    else:
        try:
            run_native(args.port, args.debug)
        except ImportError as e:
            # 常见原因：未装 pywebview，或系统缺 WebView2 Runtime
            print(f"原生窗口不可用（{e}），回退浏览器模式。")
            print("安装依赖：pip install pywebview")
            print("WebView2 Runtime：https://developer.microsoft.com/microsoft-edge/webview2/")
            run_web(args.port)


if __name__ == "__main__":
    main()
```

要点核对：`uvicorn.Server` + `should_exit`（**不要**用 `uvicorn.run` 起线程——它无法被停止）；`webview.start()` 必须在主线程；服务 `started` 之后再开窗口。

---

## 5. 已知坑（务必逐条读完再动手）

1. **`window.alert / confirm / prompt` 在 pywebview 里全部不可用**（静默返回 undefined/falsy，不报错）。不要试图验证后保留它们——5 处必须全部替换（§7.3）。
2. **`window.pywebview.api` 是异步出现的**。页面加载后 `window.pywebview` 可能还不存在；必须轮询或监听 `pywebviewready` 事件，带超时回退。禁止在模块顶层直接访问它。
3. **js_api 方法在后台线程执行**，返回值必须可 JSON 序列化（`pick_folder` 返回 `str`）。方法内部不要做耗时操作。
4. **uvicorn 停止**：只能 `uvicorn.Server` 实例 + `should_exit = True`；线程设为 daemon 兜底。
5. **WebView2 用户数据目录**：pywebview 会在 `%LOCALAPPDATA%` 下建 WebView2 配置目录，属正常现象，不用处理。
6. **剪贴板**：`navigator.clipboard` 在 `http://127.0.0.1`（安全上下文）+ WebView2 下可用，无需改动；验收时确认「复制提示词」按钮仍工作即可。
7. **关闭窗口时未保存的画板改动**：`beforeunload` 的 fetch 在原生窗口关闭时大概率被取消 → 用 §7.1 的防抖自动保存根治，`beforeunload` 保留当双保险。
8. **调试方法**：`python run.py --debug` 会打开 WebView2 DevTools（Console/Network 都能用），这是排查前端问题的第一手段。
9. **端口占用**：测试前确认 8770 空闲（`netstat -ano | findstr :8770`），必要时先结束旧进程，否则会出现「窗口打开了但显示错误页」的假故障。

---

## 6. 实施步骤（建议顺序）

1. `pip install pywebview`；重写 `run.py`（§4）；先用 `--web` 与不带参数各跑一遍，确认窗口能开、网格能显示 `tests/fixtures` 的图（若图库为空，可先点「＋ 文件夹」添加 `E:\VS\texture\tests\fixtures`——此时添加按钮还是 `prompt`，在原生窗口里无效，属预期；可临时用 `--web` 添加根目录后再切回原生验证）。
2. 新建 `web/dialogs.js`（或并入 `app.js`，二选一，保持与现有代码风格一致）：实现 §7.3 的 `customModal` + `pickFolder/whenNative` + `appConfirm/appPrompt/appAlert`；`index.html` 在 `app.js` 之前引入；`style.css` 加样式（深色主题与现有变量一致，参考 `style.css` 里的 `--fg-dim` 等用法）。
3. 替换 5 处弹窗调用点（§7.3 表格）。
4. 实现 §7.1 画板自动保存。
5. 更新 `requirements.txt`、`README.md`（运行方式：默认原生窗口、`--web` 回退）、`需求表.md` NFR-4 一行（依赖加 pywebview）。
6. 跑 §9 验收清单。

---

## 7. 各改动点规格

### 7.1 画板自动保存（P0，根治关窗丢布局）

`web/board.js`：把所有 `dirty = true` 的赋值点改为调用 `markDirty()`：

```js
let saveTimer = null;
function markDirty() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 2500);   // 防抖 2.5s 自动保存
}
```

`save()` 内部加一个进行中标志避免重入；手动「保存布局」按钮保留；`beforeunload` 保留不改。

### 7.2 顺带修复（P1，两处已确认的小 bug，位置精确，顺手修掉）

在 `app/main.py`：

1. **root 过滤前缀漏洞**（`api_images` 内，约 143 行）：`it["path"].startswith(root)` 会把 `E:\a\libA_backup` 混进 `E:\a\libA` 的过滤结果。改为：
   ```python
   if root and not Path(it["path"]).is_relative_to(Path(root)):
       continue
   ```
2. **画板导出相对路径**（`api_export_board` 内，约 301 行）：`out = Path("data") / f"board_{bid}{suffix}.html"` 依赖进程工作目录，换目录启动会 FileNotFoundError。改为从 `app.store` 导入 `DATA_DIR` 并使用：`out = DATA_DIR / f"board_{bid}{suffix}.html"`。

### 7.3 前端弹窗替换（P0，5 处 + 1 个选择器）

**新建 `web/dialogs.js`**（在 `index.html` 中、`app.js` 之前引入），参考实现：

```js
/* 双模式弹窗：原生窗口走 pywebview 桥，浏览器走 prompt/confirm 或自定义模态 */
"use strict";

const customModal = (() => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let root = null;
  function open({ body, input = false, value = "", okText = "确定", danger = false }) {
    return new Promise((resolve) => {
      if (!root) { root = document.createElement("div"); root.id = "app-modal"; document.body.appendChild(root); }
      root.innerHTML = `
        <div class="am-mask"></div>
        <div class="am-box">
          <div class="am-body">${esc(body)}</div>
          ${input ? `<input class="am-input" value="${esc(value)}">` : ""}
          <div class="am-btns">
            <button class="am-cancel">取消</button>
            <button class="am-ok${danger ? " danger" : ""}">${okText}</button>
          </div>
        </div>`;
      const done = (v) => { root.innerHTML = ""; resolve(v); };
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
  if (await nativeReady()) return window.pywebview.api.pick_folder();
  return (await customModal.prompt(
    "输入图片文件夹的绝对路径：\n（例如 D:\\outputs 或 D:\\ComfyUI\\output）", "")) || "";
}
const appConfirm = (m) => customModal.confirm(m);   // 统一走自定义模态，双模式一致
const appPrompt = (m, v) => customModal.prompt(m, v);
const appAlert = (m) => customModal.alert(m);
```

**调用点替换表**（用选择器/文案定位，行号仅参考）：

| 文件 | 位置 | 原代码 | 改为 |
|---|---|---|---|
| `web/app.js` | `#btn-add-root` 点击（~248） | `const path = prompt("输入图片文件夹的绝对路径：…"); if (!path) return;` | `const path = await pickFolder(); if (!path) return;` |
| `web/app.js` | 同处理器 catch 分支（~253） | `alert("添加失败：" + e.message);` | `appAlert("添加失败：" + e.message);` |
| `web/app.js` | 根目录 ✕（~128） | `if (!confirm(\`从图库移除…\n${r}\`)) return;` | `if (!(await appConfirm(\`从图库移除该文件夹？（不会删除文件）\n${r}\`))) return;` |
| `web/board.js` | `#board-new`（~168） | `const name = prompt("画板名称：", "参考板 " + …); if (name === null) return;` | `const name = await appPrompt("画板名称：", "参考板 " + new Date().toLocaleDateString()); if (name === null || name === "") return;` |
| `web/board.js` | `#board-delete`（~176） | `if (!confirm(\`删除画板「${board.name}」？…\`)) return;` | `if (!(await appConfirm(\`删除画板「${board.name}」？（图片文件不受影响）\`))) return;` |

注意：这些处理器所在函数需为 `async`（原代码里 `#btn-add-root` 的回调已是 async，其余检查补齐）。**不要**再出现任何裸的 `window.prompt/confirm/alert`。

### 7.4 打包 exe（P2，本次默认跳过；用户明确要求时才做）

PyInstaller onedir 模式：`pyinstaller --windowed --name Texture --collect-all clr_loader --collect-all pythonnet --add-data "web;web" run.py`。注意 `app/main.py` 的 `WEB_DIR = Path(__file__).resolve().parent.parent / "web"` 在打包后需增加 `sys._MEIPASS` 兜底；`data/` 建议落到 exe 同级目录。此节坑多，独立任务再做。

---

## 8. 禁止事项

1. 禁止更换技术栈（不要 Electron/Tauri/Qt/Flask 等任何替代方案）。
2. 禁止改动 `app/metadata/` 下任何文件、`tests/` 下任何文件。
3. 禁止引入构建工具（npm/webpack/vite）、CDN、外部字体（NFR-2：零网络依赖）。
4. 禁止把服务绑定到 `0.0.0.0` 或改动 API 路由语义。
5. 禁止删除 `--web` 回退模式。
6. 除 `pywebview` 外不得新增任何 pip 依赖。
7. 界面保持全中文；代码注释风格与现有文件一致（中文、简短、说明「为什么」）。

---

## 9. 验收清单（Definition of Done）

环境准备：`pip install -r requirements.txt` 成功；`netstat -ano | findstr :8770` 无占用。

- [ ] `python run.py` ≤3s 内弹出标题「Texture」的原生窗口，无地址栏；窗口内网格、过滤、搜索正常。
- [ ] 「＋ 文件夹」→ 弹出**系统原生文件夹选择器**；选中一个含 AI 图的目录后网格出现图片；重复添加同一目录幂等不重复；添加重叠目录被拒绝并弹出自定义提示框。
- [ ] 根目录 ✕ → 自定义确认框 → 取消不动、确定后列表消失。
- [ ] 灯箱：点击缩略图打开；参数/提示词/原始数据三个页签正常；「复制提示词」等按钮真的写入剪贴板；左右方向键翻页、Esc 关闭。
- [ ] 收藏加星、标签添加/移除/过滤正常（重启窗口后仍在——SQLite 持久化）。
- [ ] 画板：新建（自定义输入框）→ 从素材抽屉拖图上板 → 平移/滚轮缩放/拖动/右下角缩放 → 改动后**不点保存**、等 3 秒 → 关闭窗口重开，布局还在（自动保存生效）→ 导出 HTML 得到自包含文件 → 删除画板有确认框。
- [ ] `python run.py --web`：自动开浏览器，一切功能同前；「＋ 文件夹」回退为输入框弹窗。
- [ ] `python run.py --debug`：能打开 DevTools。
- [ ] 关闭原生窗口后进程退出：`netstat -ano | findstr :8770` 无监听、任务管理器无残留 python。
- [ ] `python tests/test_readers.py` 输出「通过 43 / 43」。
- [ ] `requirements.txt` 含 `pywebview>=5.1,<6`；全新 `pip install -r requirements.txt` 后以上流程可复现。

全部勾选后，在最终回复里报告：改动文件清单、验收逐项结果、以及执行中做出的所有小偏差决定。
