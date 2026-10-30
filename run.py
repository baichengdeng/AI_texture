"""Texture 启动入口。

用法：
    python run.py                     # 原生桌面窗口（pywebview/WebView2）
    python run.py --web               # 浏览器模式（旧行为，调试用）
    python run.py --port 9000         # 指定端口（前后端同一端口）
    python run.py --host 0.0.0.0      # 监听地址（局域网可访问）
    python run.py --debug             # WebView2 开发者工具 + uvicorn info 日志
    python run.py --no-browser        # 不自动打开浏览器（--web 模式也生效）

日常使用建议走图形启动器：python launcher.py（或双击「启动 Texture.pyw」），
可在里面选桌面/浏览器/仅服务，并自行设置端口与地址。

端口策略：启动前自动检测 8770（或 --port）占用——
是 Texture 旧实例 / 残留 python 进程 → 自动关闭后接管；
是其他程序 → 打印明确提示并退出，不会误杀。
"""
import argparse
import os
import socket
import subprocess
import sys
import threading
import time

import uvicorn

# Windows 控制命令输出本地编码（中文系统为 GBK），mbcs 即系统 ANSI 代码页
_CMD_ENCODING = "mbcs" if sys.platform == "win32" else "utf-8"

# 桌面窗口始终通过回环地址访问；--host 只控制服务监听范围
LOCAL = "127.0.0.1"


def lan_ip() -> str:
    """本机在局域网中的 IPv4 地址，取不到时返回 127.0.0.1。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))   # 不真正发包，只为让系统选出默认出口网卡
            return s.getsockname()[0]
    except OSError:
        return LOCAL


def visit_url(host: str, port: int) -> str:
    """给人看的访问地址：监听 0.0.0.0 时给出局域网地址。"""
    shown = lan_ip() if host in ("0.0.0.0", "::") else host
    return f"http://{shown}:{port}"


# ---------------- 端口占用检测与清理 ----------------

def _port_pids(port: int) -> list:
    """返回监听该端口的 PID 列表（netstat 解析）。"""
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True, text=True, encoding=_CMD_ENCODING, errors="replace", timeout=5,
        ).stdout or ""
    except Exception:
        return []
    pids = []
    for line in out.splitlines():
        if f":{port} " in line and "LISTENING" in line:
            parts = line.split()
            if parts and parts[-1].isdigit() and parts[-1] not in pids:
                pids.append(parts[-1])
    return pids


def _pid_image(pid: str) -> str:
    """PID 对应的进程名（tasklist 解析），失败返回 '?'。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}"],
            capture_output=True, text=True, encoding=_CMD_ENCODING, errors="replace", timeout=5,
        ).stdout or ""
        for line in out.splitlines():
            cols = line.split()
            if len(cols) >= 2 and cols[1] == pid:
                return cols[0]
    except Exception:
        pass
    return "?"


def _is_texture_instance(port: int) -> bool:
    """判断端口上的服务是不是 Texture 自己（探 /api/roots）。"""
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/roots", timeout=1.5) as r:
            return r.status == 200 and b"roots" in r.read()
    except Exception:
        return False


def free_port(port: int) -> None:
    """端口被占时：Texture 旧实例或残留 python 自动关闭；其他程序则提示并退出。"""
    pids = _port_pids(port)
    if not pids:
        return
    ours = _is_texture_instance(port)
    for pid in pids:
        img = _pid_image(pid)
        if ours or img.lower().startswith("python"):
            subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
            print(f"[端口] 已自动关闭旧进程 {img} (PID {pid}) —— 它占着端口 {port}", flush=True)
        else:
            print(f"[端口] 端口 {port} 被其他程序占用：{img} (PID {pid})。", flush=True)
            print(f"[端口] 请关闭该程序，或在启动器里换一个端口（python launcher.py）", flush=True)
            sys.exit(1)
    time.sleep(0.6)   # 等端口释放


def start_server(host: str, port: int, log_level: str = "warning") -> uvicorn.Server:
    """后台线程启动 uvicorn，返回可控制停止的 Server 对象。"""
    config = uvicorn.Config("app.main:app", host=host, port=port,
                            log_level=log_level)
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):  # 最多等 5s，避免窗口先加载出错误页
        if server.started:
            return server
        time.sleep(0.05)
    raise RuntimeError(f"服务启动失败：{host}:{port} 无法监听（端口被占用？）")


def run_web(host: str, port: int, no_browser: bool = False):
    """浏览器模式（保留旧行为）。"""
    if not no_browser:
        import webbrowser
        # 浏览器永远打开回环地址：host 为 0.0.0.0 时 0.0.0.0 本身不可作为网址浏览
        threading.Timer(1.5, webbrowser.open, args=(f"http://{LOCAL}:{port}",)).start()
    print(f"Texture 已启动 → {visit_url(host, port)}   (Ctrl+C 退出)", flush=True)
    uvicorn.run("app.main:app", host=host, port=port, log_level="warning")


class NativeApi:
    """暴露给前端 window.pywebview.api 的原生能力（方法在后台线程被调用）。"""

    def pick_folder(self):
        import webview
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        # 返回 str 列表或 None；约定返回首个路径字符串，取消返回 ""
        return result[0] if result else ""


def run_native(host: str, port: int, debug: bool):
    import webview

    from app.settings import DATA_DIR

    server = start_server(host, port, "info" if debug else "warning")
    webview.create_window(
        "Texture", f"http://{LOCAL}:{port}",
        js_api=NativeApi(), width=1400, height=900, min_size=(960, 640),
    )
    try:
        # private_mode=False + 固定的 storage_path：WebView2 才会把 localStorage
        # 落到磁盘上。默认的隐私模式每次都用临时配置目录，主题、布局等记忆
        # 一关就全没了（表现为「选了深色，下次打开又是亮色」）。
        profile = os.path.join(str(DATA_DIR), "webview")
        os.makedirs(profile, exist_ok=True)
        webview.start(debug=debug, private_mode=False, storage_path=profile)
    finally:
        server.should_exit = True
        time.sleep(0.2)


def main():
    ap = argparse.ArgumentParser(description="Texture — AI 图片元数据管理")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--host", default=LOCAL, help="监听地址，0.0.0.0 允许局域网访问")
    ap.add_argument("--web", action="store_true", help="浏览器模式（调试用）")
    ap.add_argument("--debug", action="store_true", help="WebView2 开发者工具")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()
    if not 1 <= args.port <= 65535:
        print(f"[端口] 端口 {args.port} 超出范围（1–65535）")
        sys.exit(2)
    free_port(args.port)   # 统一入口：先清掉旧实例再启动
    if args.web:
        run_web(args.host, args.port, args.no_browser)
    else:
        try:
            run_native(args.host, args.port, args.debug)
        except ImportError as e:
            # 常见原因：未装 pywebview，或系统缺 WebView2 Runtime
            print(f"原生窗口不可用（{e}），回退浏览器模式。")
            print("安装依赖：pip install pywebview")
            print("WebView2 Runtime：https://developer.microsoft.com/microsoft-edge/webview2/")
            run_web(args.host, args.port, args.no_browser)


if __name__ == "__main__":
    main()
