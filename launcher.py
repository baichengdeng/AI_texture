"""Texture 图形启动器。

打开后先让你选启动方式，再决定端口与地址，避免每次记命令行参数：

    桌面模式   —— 打开原生窗口（pywebview / WebView2），最常用
    浏览器模式 —— 用默认浏览器打开，调样式或临时看效果时方便
    指定端口   —— 只启动服务，不打开任何界面，自己用任意浏览器访问

三种方式共用同一个 4 位端口（默认 8770），端口与监听地址都能在窗口里改，
端口被占用时会直接标红并给出一键换端口的入口。

运行：python launcher.py    （或双击「启动 Texture.pyw」）
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
CONFIG_PATH = DATA / "launcher.json"
LOG_PATH = DATA / "launcher.log"

try:
    import tkinter as tk
    from tkinter import messagebox
except Exception as _tk_exc:            # 用错解释器（例如没装 tkinter 的 Python）
    def _abort(reason: object) -> None:
        text = (f"无法打开 Texture 启动器：{reason}\n\n"
                "当前 Python 解释器没有 tkinter。\n"
                "请改用项目目录里的「启动 Texture.bat」，它会自动挑选合适的解释器。")
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write("\n[launcher] " + text + "\n")
        except OSError:
            pass
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, text, "Texture 启动器", 0x10)
        except Exception:
            print(text, file=sys.stderr)
        raise SystemExit(1)

    _abort(_tk_exc)

PYTHON = sys.executable or "python"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
HAS_WEBVIEW = True
try:                                    # 桌面模式依赖 pywebview，缺失时禁用该选项
    import importlib.util
    HAS_WEBVIEW = importlib.util.find_spec("webview") is not None
except Exception:                       # pragma: no cover
    HAS_WEBVIEW = False

# ---------------- 外观 ----------------
BG = "#f4f4f1"
CARD = "#ffffff"
INK = "#1c1c1c"
MUTED = "#7c7c74"
LINE = "#dcdcd4"
SIGNAL = "#f2e400"
SIGNAL_DARK = "#cabf00"
BAR = "#1a1a1a"
OK = "#1f8a4c"
WARN = "#a86a00"
BAD = "#c0392b"
FONT = "Microsoft YaHei UI"

DEFAULT_PORT = 8770
HOST_PRESETS = ["127.0.0.1", "0.0.0.0"]

MODES = {
    "native": ("▣", "桌面模式", "原生窗口 · WebView2"),
    "web": ("◎", "浏览器模式", "用默认浏览器打开"),
    "port": ("⌗", "指定端口", "只启动服务，自己访问"),
}


# ---------------- 配置 ----------------

def load_config() -> dict:
    cfg = {"mode": "native", "host": "127.0.0.1", "port": DEFAULT_PORT,
           "remember": True, "debug": False, "python": ""}
    try:
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(saved, dict):
            cfg.update({k: v for k, v in saved.items() if k in cfg})
    except (OSError, ValueError):
        pass
    if not isinstance(cfg.get("port"), int) or not 1000 <= cfg["port"] <= 9999:
        cfg["port"] = DEFAULT_PORT
    if cfg.get("mode") not in MODES:
        cfg["mode"] = "native"
    if not isinstance(cfg.get("host"), str) or not cfg["host"].strip():
        cfg["host"] = "127.0.0.1"
    return cfg


def save_config(cfg: dict) -> None:
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                               encoding="utf-8")
    except OSError:
        pass


# ---------------- 端口与地址探测 ----------------

def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """有进程在监听该端口。

    必须用阻塞 connect，且不能 settimeout：Windows 上带超时的 socket 会进入
    非阻塞模式，connect_ex 立刻返回 WSAEWOULDBLOCK(10035)、connect 则抛
    TimeoutError，两者都会把「已占用」误判成空闲。回环 connect 本身是 0ms，
    不需要超时保护。
    """
    probe = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.connect((probe, port))
            return True
        except OSError:
            return False


def is_texture(port: int) -> bool:
    """端口上的服务是不是 Texture（探 /api/roots）。"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/roots", timeout=0.8) as r:
            return r.status == 200 and b"roots" in r.read()
    except Exception:
        return False


def port_state(port: int, host: str) -> tuple[str, str]:
    """返回 (状态, 说明文案)。状态：free / texture / busy / invalid。

    顺序很重要：先判断端口有没有人监听，再判断是不是 Texture。
    反过来的话，is_texture 会先占用对方 listen backlog，导致后续探测挂起。
    """
    if not isinstance(port, int) or not 1000 <= port <= 9999:
        return "invalid", "需要 4 位数字（1000–9999）"
    if not port_in_use(port, host):
        return "free", "可用"
    if is_texture(port):
        return "texture", "已有 Texture 在跑，启动时会接管它"
    return "busy", "被其他程序占用，换个端口"


def find_free_port(start: int) -> int:
    """从 start 往上找第一个可用端口，最多试 200 个。"""
    for port in range(max(1000, start), min(9999, start + 200) + 1):
        if not port_in_use(port):
            return port
    return DEFAULT_PORT


def build_cmd(mode: str, host: str, port: int, debug: bool,
              python_exe: str | None = None) -> list[str]:
    """拼出 run.py 的命令行。"""
    cmd = [python_exe or PYTHON, "run.py", "--port", str(port), "--host", host]
    if mode == "web":
        cmd.append("--web")
    elif mode == "port":
        cmd += ["--web", "--no-browser"]
    if mode == "native" and debug:
        cmd.append("--debug")
    return cmd


# ---------------- 解释器探测 ----------------
#
# 双击启动时，PATH 里的 python/pythonw 未必是装了依赖的那一个
# （例如系统同时存在多个 Python，fastapi 只装在其中一个）。
# 选错的表现是启动器正常弹出、点启动后服务起不来，很难自查，
# 所以这里主动挑一个真的能 import fastapi/uvicorn/PIL 的解释器。

REQUIRED = "import fastapi, uvicorn, PIL"


def has_deps(exe: str) -> bool:
    try:
        r = subprocess.run([exe, "-c", REQUIRED], capture_output=True,
                           timeout=15, creationflags=CREATE_NO_WINDOW)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def python_candidates() -> list[str]:
    """按可靠性排序的解释器候选；同一路径只留一个。"""
    raw: list[str] = []
    if sys.executable:
        raw.append(sys.executable)
    for name in ("python.exe", "pythonw.exe", "python3.exe"):
        found = shutil.which(name)
        if found:
            raw.append(found)
    patterns = (
        r"%LOCALAPPDATA%\Python\pythoncore-*\python.exe",
        r"%LOCALAPPDATA%\Programs\Python\Python3*\python.exe",
        r"%PROGRAMFILES%\Python3*\python.exe",
        r"C:\Python3*\python.exe",
    )
    for pat in patterns:
        raw.extend(sorted(glob.glob(os.path.expandvars(pat)), reverse=True))
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        try:
            key = os.path.normcase(os.path.abspath(item))
        except (OSError, ValueError):
            continue
        if key in seen or not os.path.isfile(item):
            continue
        seen.add(key)
        out.append(item)
    return out


def resolve_python(cached: str | None = None) -> tuple[str, str, bool]:
    """返回 (解释器, 说明, 依赖是否齐全)。"""
    if cached and os.path.isfile(cached) and has_deps(cached):
        return cached, f"Python {_ver_of(cached)}", True
    for exe in python_candidates():
        if has_deps(exe):
            return exe, f"Python {_ver_of(exe)}", True
    return PYTHON, "未找到依赖", False


def _ver_of(exe: str) -> str:
    try:
        r = subprocess.run([exe, "-c", "import sys;print('%d.%d'%sys.version_info[:2])"],
                           capture_output=True, timeout=10, text=True,
                           creationflags=CREATE_NO_WINDOW)
        return (r.stdout or "").strip() or "?"
    except (OSError, subprocess.SubprocessError):
        return "?"


# ---------------- 界面 ----------------

class Launcher(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        cfg = load_config()
        self.cfg = cfg
        self.mode = tk.StringVar(value=cfg["mode"])
        self.host = tk.StringVar(value=cfg["host"])
        self.port_text = tk.StringVar(value=str(cfg["port"]))
        self.remember = tk.BooleanVar(value=bool(cfg["remember"]))
        self.debug = tk.BooleanVar(value=bool(cfg["debug"]))
        self._cards: dict[str, dict] = {}
        self._busy = False
        self._closed = False
        self._port_timer: str | None = None
        self.python_exe: str | None = cfg.get("python") or None
        self.deps_ok = True

        self.title("Texture 启动器")
        self.configure(bg=BG)
        self.resizable(False, False)
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self._center(600, 470)
        self._build()
        self._sync_mode()
        self.update_idletasks()
        self._decorate()
        self.bind("<Return>", lambda e: self.launch())
        self.bind("<Escape>", lambda e: self.destroy())
        # 窗口先画出来再检测：端口探测几乎瞬时，解释器探测可能要 1–2 秒
        self.after(60, self._check_port)
        self.after(140, self._check_env)

    # -- 布局 --
    def _center(self, w: int, h: int) -> None:
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"{w}x{h}+{(sw - w) // 2}+{max(0, (sh - h) // 2 - 40)}")

    def destroy(self) -> None:
        self._closed = True
        if self._port_timer is not None:
            try:
                self.after_cancel(self._port_timer)
            except tk.TclError:
                pass
            self._port_timer = None
        super().destroy()

    def _decorate(self) -> None:
        """窗口图标与深色标题栏，跟应用内配色统一。"""
        if sys.platform != "win32":
            return
        try:
            icon = tk.PhotoImage(width=32, height=32)
            icon.put(SIGNAL, to=(0, 0, 32, 32))
            icon.put(INK, to=(6, 13, 26, 19))
            icon.put(INK, to=(14, 6, 18, 26))
            self.iconphoto(True, icon)
            self._icon = icon          # 保持引用，否则会被回收
        except tk.TclError:
            pass
        try:
            import ctypes
            hwnd = ctypes.windll.user32.GetParent(self.winfo_id())
            dark = ctypes.c_int(1)
            for attr in (20, 19):      # DWMWA_USE_IMMERSIVE_DARK_MODE / 旧版本
                if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                        hwnd, attr, ctypes.byref(dark), ctypes.sizeof(dark)) == 0:
                    break
        except Exception:
            pass

    def _build(self) -> None:
        bar = tk.Frame(self, bg=BAR, height=58)
        bar.pack(fill="x")
        bar.pack_propagate(False)
        seal = tk.Label(bar, text="T", bg=SIGNAL, fg=INK, font=(FONT, 15, "bold"),
                        width=2, height=1)
        seal.pack(side="left", padx=(18, 10), pady=13)
        tk.Label(bar, text="TEXTURE", bg=BAR, fg="#ffffff",
                 font=(FONT, 13, "bold")).pack(side="left")
        tk.Label(bar, text="启动器", bg=BAR, fg="#8f8f87",
                 font=(FONT, 9)).pack(side="right", padx=18)

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True, padx=20, pady=(16, 0))

        tk.Label(body, text="选择启动方式", bg=BG, fg=INK,
                 font=(FONT, 10, "bold")).pack(anchor="w")

        cards = tk.Frame(body, bg=BG)
        cards.pack(fill="x", pady=(8, 0))
        for i, key in enumerate(("native", "web", "port")):
            self._cards[key] = self._make_card(cards, key)
            self._cards[key]["frame"].grid(row=0, column=i, sticky="nsew",
                                           padx=(0 if i == 0 else 8, 0))
            cards.grid_columnconfigure(i, weight=1, uniform="card")

        # 端口 / 地址
        form = tk.Frame(body, bg=BG)
        form.pack(fill="x", pady=(18, 0))
        form.grid_columnconfigure(1, weight=1)

        tk.Label(form, text="端口", bg=BG, fg=INK, font=(FONT, 9, "bold"),
                 width=6, anchor="w").grid(row=0, column=0, sticky="w", pady=5)
        self.port_entry = tk.Entry(form, textvariable=self.port_text, width=7,
                                   font=(FONT, 11, "bold"), bg=CARD, fg=INK,
                                   relief="flat", justify="center",
                                   highlightthickness=1, highlightbackground=LINE,
                                   highlightcolor=SIGNAL_DARK, insertbackground=INK)
        self.port_entry.grid(row=0, column=1, sticky="w", ipady=4)
        self.port_entry.bind("<KeyRelease>", self._on_port_input)

        port_right = tk.Frame(form, bg=BG)
        port_right.grid(row=0, column=2, sticky="e")
        self.port_badge = tk.Label(port_right, text="", bg=BG, fg=MUTED,
                                   font=(FONT, 9))
        self.port_badge.pack(side="left")
        tk.Button(port_right, text="↻ 换一个", command=self._auto_port,
                  font=(FONT, 8), bg=BG, fg=MUTED, activebackground=BG,
                  activeforeground=INK, relief="flat", bd=0, cursor="hand2",
                  ).pack(side="left", padx=(14, 0))

        tk.Label(form, text="地址", bg=BG, fg=INK, font=(FONT, 9, "bold"),
                 width=6, anchor="w").grid(row=1, column=0, sticky="w", pady=5)
        host_row = tk.Frame(form, bg=BG)
        host_row.grid(row=1, column=1, sticky="w")
        self.host_entry = tk.Entry(host_row, textvariable=self.host, width=15,
                                   font=(FONT, 9), bg=CARD, fg=INK, relief="flat",
                                   highlightthickness=1, highlightbackground=LINE,
                                   highlightcolor=SIGNAL_DARK, insertbackground=INK)
        self.host_entry.pack(side="left", ipady=4)
        for label, value in (("本机", "127.0.0.1"), ("局域网", "0.0.0.0")):
            tk.Button(host_row, text=label, command=lambda v=value: self._set_host(v),
                      font=(FONT, 8), bg=BG, fg=MUTED, activebackground=BG,
                      activeforeground=INK, relief="flat", bd=0, cursor="hand2",
                      ).pack(side="left", padx=(8, 0))
        self.host_hint = tk.Label(form, text="", bg=BG, fg=MUTED, font=(FONT, 9))
        self.host_hint.grid(row=1, column=2, sticky="e")
        self.host.trace_add("write", lambda *_: self._sync_host_hint())

        # 选项
        opts = tk.Frame(body, bg=BG)
        opts.pack(fill="x", pady=(14, 0))
        self.debug_chk = tk.Checkbutton(
            opts, text="开发者工具（桌面模式）", variable=self.debug,
            font=(FONT, 9), bg=BG, fg=MUTED, activebackground=BG,
            selectcolor=CARD, bd=0, highlightthickness=0, cursor="hand2",
            command=self._sync_mode)
        self.debug_chk.pack(side="left")
        tk.Checkbutton(opts, text="记住这次选择", variable=self.remember,
                       font=(FONT, 9), bg=BG, fg=MUTED, activebackground=BG,
                       selectcolor=CARD, bd=0, highlightthickness=0,
                       cursor="hand2").pack(side="left", padx=(18, 0))

        # 底部
        foot = tk.Frame(self, bg=BG)
        foot.pack(fill="x", side="bottom", padx=20, pady=(0, 16))
        line = tk.Frame(foot, bg=BG)
        line.pack(fill="x", pady=(0, 10))
        self.status = tk.Label(line, text="", bg=BG, fg="#9a9a92", font=(FONT, 9),
                               anchor="w")
        self.status.pack(side="left")
        self.env_label = tk.Label(line, text="检测运行环境…", bg=BG, fg="#9a9a92",
                                  font=(FONT, 8), anchor="e")
        self.env_label.pack(side="right")

        btns = tk.Frame(foot, bg=BG)
        btns.pack(fill="x")
        self.launch_btn = tk.Button(btns, text="启 动", command=self.launch,
                                    font=(FONT, 11, "bold"), bg=SIGNAL, fg=INK,
                                    activebackground=SIGNAL_DARK,
                                    relief="flat", bd=0, cursor="hand2",
                                    width=16, pady=7)
        self.launch_btn.pack(side="right")
        tk.Button(btns, text="退出", command=self.destroy, font=(FONT, 10),
                  bg=BG, fg=MUTED, activebackground=BG, activeforeground=INK,
                  relief="flat", bd=0, cursor="hand2", width=8,
                  ).pack(side="right", padx=(0, 10))

    def _make_card(self, parent: tk.Frame, key: str) -> dict:
        icon, title, sub = MODES[key]
        frame = tk.Frame(parent, bg=CARD, cursor="hand2",
                         highlightthickness=1, highlightbackground=LINE,
                         highlightcolor=SIGNAL)
        inner = tk.Frame(frame, bg=CARD, cursor="hand2")
        inner.pack(fill="both", expand=True, padx=12, pady=11)
        ico = tk.Label(inner, text=icon, bg=CARD, fg=INK, font=(FONT, 15),
                       cursor="hand2")
        ico.pack(anchor="w")
        name = tk.Label(inner, text=title, bg=CARD, fg=INK,
                        font=(FONT, 10, "bold"), cursor="hand2")
        name.pack(anchor="w", pady=(4, 0))
        desc = tk.Label(inner, text=sub, bg=CARD, fg=MUTED, font=(FONT, 8),
                        cursor="hand2", justify="left")
        desc.pack(anchor="w")
        for w in (frame, inner, ico, name, desc):
            w.bind("<Button-1>", lambda e, k=key: self._pick(k))
        return {"frame": frame, "icon": ico, "name": name, "desc": desc}

    # -- 交互 --
    def _pick(self, key: str) -> None:
        if key == "native" and not HAS_WEBVIEW:
            messagebox.showwarning(
                "桌面模式不可用",
                "未检测到 pywebview。\n\n安装后可启用桌面窗口：\n    pip install pywebview\n\n"
                "现在请先用「浏览器模式」或「指定端口」。")
            return
        self.mode.set(key)
        self._sync_mode()

    def _sync_mode(self) -> None:
        for key, parts in self._cards.items():
            on = key == self.mode.get()
            parts["frame"].configure(highlightbackground=SIGNAL if on else LINE,
                                     highlightthickness=2 if on else 1)
            # 未选中也用深色字，只把图标压低一档，避免看起来像禁用
            parts["icon"].configure(fg=INK if on else "#8f8f87")
            parts["name"].configure(fg=INK)
            parts["desc"].configure(fg=MUTED)
        if not HAS_WEBVIEW:
            self._cards["native"]["desc"].configure(text="未安装 pywebview", fg=BAD)
        state = "normal" if self.mode.get() == "native" else "disabled"
        self.debug_chk.configure(state=state,
                                 fg=MUTED if state == "normal" else "#c3c3bb")
        self._sync_host_hint()
        self._sync_summary()

    def _sync_summary(self) -> None:
        if self._busy:
            return
        mode = MODES[self.mode.get()][1]
        host = self.host.get().strip() or "127.0.0.1"
        self.status.configure(
            text=f"{mode} · {host}:{self.port_text.get()}", fg="#9a9a92")

    def _set_host(self, value: str) -> None:
        self.host.set(value)
        self._sync_summary()
        self._schedule_port_check()

    def _sync_host_hint(self) -> None:
        host = self.host.get().strip()
        if host in ("0.0.0.0", "::"):
            self.host_hint.configure(text="局域网可访问", fg=WARN)
        elif host in ("127.0.0.1", "localhost", ""):
            self.host_hint.configure(text="仅本机可访问", fg=MUTED)
        else:
            self.host_hint.configure(text="自定义地址", fg=MUTED)

    def _on_port_input(self, _ev=None) -> None:
        raw = "".join(ch for ch in self.port_text.get() if ch.isdigit())[:4]
        if raw != self.port_text.get():
            self.port_text.set(raw)
        self._sync_summary()
        self._schedule_port_check()

    def _auto_port(self) -> None:
        try:
            current = int(self.port_text.get())
        except ValueError:
            current = DEFAULT_PORT
        found = find_free_port(current + 1)
        self.port_text.set(str(found))
        self._sync_summary()
        self._schedule_port_check(note=f"已换到 {found}")

    def _schedule_port_check(self, note: str = "") -> None:
        """按键后再查，避免每敲一个数字就同步探测一次。"""
        if self._port_timer is not None:
            try:
                self.after_cancel(self._port_timer)
            except tk.TclError:
                pass
            self._port_timer = None
        try:
            self._port_timer = self.after(280, lambda: self._check_port(note))
        except tk.TclError:
            self._port_timer = None

    def _check_port(self, note: str = "") -> None:
        """同步探测端口。回环探测通常 <10ms，最坏（对端是裸监听）约 0.8s。"""
        self._port_timer = None
        try:
            port = int(self.port_text.get())
        except ValueError:
            port = -1
        host = self.host.get().strip() or "127.0.0.1"
        self.port_badge.configure(text="检测中…", fg=MUTED)
        try:
            self.update_idletasks()
        except tk.TclError:
            return
        state, text = port_state(port, host)
        self._apply_port_state(state, text, note)

    def _apply_port_state(self, state: str, text: str, note: str = "") -> None:
        color = {"free": OK, "texture": WARN, "busy": BAD, "invalid": BAD}[state]
        mark = {"free": "✓ ", "texture": "● ", "busy": "✕ ", "invalid": "✕ "}[state]
        self.port_badge.configure(text=(note + " · " if note else "") + mark + text,
                                  fg=color)
        self._port_state = state

    def _check_env(self) -> None:
        """同步探测解释器（挑一个装了依赖的），最坏 1–2 秒。"""
        self.env_label.configure(text="检测中…", fg=MUTED)
        try:
            self.update_idletasks()
        except tk.TclError:
            return
        exe, label, ok = resolve_python(self.cfg.get("python") or None)
        self._apply_env(exe, label, ok)

    def _apply_env(self, exe: str, label: str, ok: bool) -> None:
        self.python_exe = exe if ok else None
        self.deps_ok = ok
        if ok:
            self.env_label.configure(text=f"● {label}", fg=OK)
        else:
            self.env_label.configure(text="● 依赖未安装", fg=BAD)

    # -- 启动 --
    def _collect(self) -> dict | None:
        mode = self.mode.get()
        host = self.host.get().strip() or "127.0.0.1"
        try:
            port = int(self.port_text.get())
        except ValueError:
            messagebox.showerror("端口无效", "端口需要 4 位数字（1000–9999）。")
            return None
        if not 1000 <= port <= 9999:
            messagebox.showerror("端口无效", "端口需要 4 位数字（1000–9999）。")
            return None
        if mode == "native" and not HAS_WEBVIEW:
            messagebox.showerror("桌面模式不可用", "未检测到 pywebview，请改用浏览器模式。")
            return None
        return {"mode": mode, "host": host, "port": port,
                "debug": bool(self.debug.get()), "remember": bool(self.remember.get())}

    def launch(self) -> None:
        if self._busy:
            return
        cfg = self._collect()
        if not cfg:
            return
        # 启动前再核一次端口：避免把别人的服务误当成自己的接管掉
        state, text = port_state(cfg["port"], cfg["host"])
        if state == "invalid":
            messagebox.showerror("端口无效", text)
            return
        if state == "busy":
            if messagebox.askyesno("端口被占用",
                                   f"端口 {cfg['port']} {text}。\n\n"
                                   "要自动换到一个空闲端口吗？"):
                self._auto_port()
            return
        if state == "texture" and not messagebox.askokcancel(
                "已有 Texture 在运行",
                f"端口 {cfg['port']} 上已经有一个 Texture 实例。\n\n"
                "继续启动会关闭旧实例并接管这个端口，未保存的画板改动可能丢失。要继续吗？"):
            return
        if not self.deps_ok:
            if not messagebox.askokcancel(
                    "依赖未安装",
                    "没有找到装有 fastapi / uvicorn / Pillow 的 Python 解释器。\n\n"
                    "在项目目录执行：\n    pip install -r requirements.txt\n\n"
                    f"当前会尝试用：{self.python_exe or PYTHON}\n\n仍要尝试启动吗？"):
                return
        if self.remember.get():
            save_config({"mode": cfg["mode"], "host": cfg["host"],
                         "port": cfg["port"], "remember": True,
                         "debug": cfg["debug"], "python": self.python_exe or ""})
        cmd = build_cmd(cfg["mode"], cfg["host"], cfg["port"], cfg["debug"],
                        self.python_exe)
        self._busy = True
        self.launch_btn.configure(state="disabled", text="启动中…")
        self.status.configure(text="正在启动服务…", fg=MUTED)
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            log = open(LOG_PATH, "ab", buffering=0)
            log.write(f"\n===== {cfg['mode']} {cfg['host']}:{cfg['port']}{os.linesep}"
                      .encode("utf-8"))
            flags = 0
            if sys.platform == "win32":
                flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            subprocess.Popen(cmd, cwd=str(BASE), stdout=log, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, creationflags=flags)
        except Exception as exc:                      # 启动器自身不该崩
            self._fail(f"无法启动进程：{exc}")
            return
        self._verify()

    def _verify(self) -> None:
        """同步等待 /api/roots，确认服务真的起来了。最多约 8 秒。

        用 update() 手动刷界面而不是 after 轮询：启动器点完就关，
        留着的定时器会在窗口销毁后触发，拖出退出阶段的崩溃。
        """
        probe_host = "127.0.0.1" if self.host.get().strip() in ("0.0.0.0", "::") \
            else (self.host.get().strip() or "127.0.0.1")
        try:
            port = int(self.port_text.get())
        except ValueError:
            self._fail("端口无效。")
            return
        url = f"http://{probe_host}:{port}/api/roots"
        cfg = {"mode": self.mode.get(), "host": self.host.get().strip() or "127.0.0.1",
               "port": port}
        deadline = time.time() + 8.0
        shown = False
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=0.6) as r:
                    if r.status == 200:
                        self._done(cfg)
                        return
            except Exception:
                pass
            if not shown:
                shown = True
                self.status.configure(text="正在启动服务…", fg=MUTED)
            try:
                self.update()          # 让「启动中…」可见，也保持窗口可重绘
            except tk.TclError:
                return
            time.sleep(0.25)
        self._fail("服务没有在预期时间内就绪。\n\n"
                   f"日志：{LOG_PATH}\n\n"
                   "常见原因：端口被占用，或依赖未安装（pip install -r requirements.txt）。")

    def _done(self, cfg: dict) -> None:
        shown = cfg["host"]
        url = f"http://{'127.0.0.1' if shown in ('0.0.0.0', '::') else shown}:{cfg['port']}"
        if cfg["mode"] == "port":
            try:
                self.clipboard_clear()
                self.clipboard_append(url)
            except tk.TclError:
                pass
            messagebox.showinfo(
                "服务已启动",
                f"地址：{url}\n\n已复制到剪贴板，用任意浏览器打开即可。\n"
                "关闭服务：在任务管理器结束 python 进程，或用 run.py 的控制台 Ctrl+C。")
        self.destroy()

    def _fail(self, msg: str) -> None:
        self._busy = False
        self.launch_btn.configure(state="normal", text="启 动")
        self.status.configure(text="启动失败", fg=BAD)
        messagebox.showerror("启动失败", msg)


def enable_dpi_awareness() -> None:
    """Windows 高 DPI 下避免界面发虚。"""
    if sys.platform != "win32":
        return
    try:
        import ctypes
    except ImportError:
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def main() -> None:
    enable_dpi_awareness()
    code = 0
    try:
        Launcher().mainloop()
    except Exception:
        # 双击 .pyw 时没有控制台，异常必须落到日志和弹窗里，否则什么都看不到
        code = 1
        import traceback
        detail = traceback.format_exc()
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write("\n[launcher crash]\n" + detail)
        except OSError:
            pass
        try:
            messagebox.showerror("启动器异常", detail[-900:])
        except Exception:
            pass
    finally:
        # 退出阶段说明：本机若装了带原生线程的第三方组件（输入法 / 字体 / 转换库），
        # 进程收尾的 DLL detach 阶段可能打印一条 Rust panic 并以 0xC0000409 退出。
        # 实测无用户可见的报错弹窗，也不影响 Texture 服务（它是独立子进程），
        # 因此这里直接退出，跳过 Python 层的 atexit 清理。
        try:
            if sys.stdout:
                sys.stdout.flush()
        except Exception:
            pass
        os._exit(code)


if __name__ == "__main__":
    main()
