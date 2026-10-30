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
STATE_PATH = DATA / "launcher.state.json"

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
# Windows 命令行输出是本地编码（中文系统 GBK），解析 netstat/tasklist 时要用对
_CMD_ENCODING = "mbcs" if sys.platform == "win32" else "utf-8"
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
BAR = "#1a1a1a"
OK = "#1f8a4c"
WARN = "#a86a00"
BAD = "#c0392b"
FONT = "Microsoft YaHei UI"

# ---------------- 界面部件 ----------------
#
# Tk 自带的 Button / Checkbutton 在 Windows 上是原生主题绘制，颜色改不干净，
# 和主界面那套「切角 + 铺黄 + 细线」对不上。所以按钮用 Canvas 画，勾选框用
# Frame 拼——形状和配色都自己说了算，代价是要手动管 state 和悬停。

ZH = FONT                    # 中文一律雅黑
RULE = LINE
CHIP = "#e4e4e0"


def _font_ok(name: str) -> str:
    """系统里没有这个字体就退回雅黑，避免 Tk 静默用别的替代字体。"""
    try:
        from tkinter import font as _f
        return name if name in set(_f.families()) else ZH
    except Exception:
        return ZH


# 字体要在 Tk 根窗口建好之后才查得到，先占位，进 _build 时再定
LAT = LAT_L = MONO = ZH


def init_fonts() -> None:
    """拉丁用 Bahnschrift（几何窄体，DIN 一路），等宽用 Cascadia。"""
    global LAT, LAT_L, MONO
    LAT = _font_ok("Bahnschrift")
    LAT_L = _font_ok("Bahnschrift Light")
    MONO = _font_ok("Cascadia Mono")


class CutButton(tk.Canvas):
    """切角按钮：右上角切掉一块＝可以按。Tk 没有裁剪，用 Canvas 画多边形。

    只能接收 tk.Button 常用选项的一个子集（state / text / fg / bg），
    够 _set_running / _reset_idle / launch 里的 configure 用。
    """

    def __init__(self, master, text="", command=None, *, width=132, height=36,
                 primary=False, bg=BG, cut=11, font=None):
        super().__init__(master, width=width, height=height, bg=bg,
                         highlightthickness=0, bd=0, cursor="hand2")
        # 注意别叫 _w：那是 tkinter 内部存的控件路径名，覆盖掉就整个废了
        self._bw, self._bh, self._cut = width, height, cut
        self._text = text
        self._cmd = command
        self._primary = primary
        self._font = font or (ZH, 9, "bold")
        self._state = "normal"
        self._fg = None
        self._hover = False
        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)
        self.bind("<Button-1>", self._on_click)
        self._draw()

    def configure(self, **kw):
        if "state" in kw:
            self._state = kw.pop("state")
            super().configure(cursor="hand2" if self._state == "normal" else "arrow")
        if "text" in kw:
            self._text = kw.pop("text")
        if "fg" in kw:
            self._fg = kw.pop("fg")
        if "bg" in kw:
            super().configure(bg=kw.pop("bg"))
        if kw:
            super().configure(**kw)
        self._draw()

    config = configure

    def _on_enter(self, _ev=None):
        if self._state == "normal":
            self._hover = True
            self._draw()

    def _on_leave(self, _ev=None):
        if self._hover:
            self._hover = False
            self._draw()

    def _on_click(self, _ev=None):
        if self._state == "normal" and self._cmd:
            self._cmd()

    def _draw(self):
        self.delete("all")
        w, h, k = self._bw, self._bh, self._cut
        if self._state == "disabled":
            # 不可用也保持"白底细线"的同一副骨架，只是线更浅、字更灰
            face, line, fg = CARD, RULE, (self._fg or "#b7b7af")
        elif self._primary:
            # 唯一的强调色只做填充：平时墨底反白，悬停才整块铺黄
            face = SIGNAL if self._hover else INK
            line = INK
            fg = INK if self._hover else "#ffffff"
        else:
            face = CHIP if self._hover else CARD
            line = INK
            fg = self._fg or INK
        # 右下 45° 切角：与主界面所有切角统一（左上直角，右下斜切）
        self.create_polygon(1, 1, w - 1, 1, w - 1, h - k, w - k, h - 1, 1, h - 1,
                            fill=face, outline=line)
        self.create_text(w / 2, h / 2, text=self._text, fill=fg, font=self._font)


class Toggle(tk.Frame):
    """方形勾选块：铺黄＝已选。不用系统的 Checkbutton，配色才统一。"""

    def __init__(self, master, text, var, bg=BG, command=None):
        super().__init__(master, bg=bg, cursor="hand2")
        self.var = var
        self._cmd = command
        self._bg = bg
        self._enabled = True
        self._box = tk.Frame(self, width=12, height=12, bg=bg,
                             highlightthickness=1, highlightbackground=INK)
        self._box.pack(side="left", padx=(0, 7), pady=4)
        self._box.pack_propagate(False)
        self._label = tk.Label(self, text=text, bg=bg, fg=MUTED,
                               font=(ZH, 9), cursor="hand2")
        self._label.pack(side="left")
        for w in (self, self._box, self._label):
            w.bind("<Button-1>", self._toggle)
        self._sync()

    def _toggle(self, _ev=None):
        if not self._enabled:
            return
        self.var.set(not self.var.get())
        self._sync()
        if self._cmd:
            self._cmd()

    def _sync(self):
        on = bool(self.var.get())
        self._box.configure(
            bg=SIGNAL if on else self._bg,
            highlightbackground=INK if self._enabled else "#c3c3bb")
        if not self._enabled:
            self._label.configure(fg="#c3c3bb")
        else:
            self._label.configure(fg=INK if on else MUTED)

    def configure(self, **kw):
        if "state" in kw:
            self._enabled = kw.pop("state") != "disabled"
            super().configure(cursor="hand2" if self._enabled else "arrow")
            self._box.configure(cursor="hand2" if self._enabled else "arrow")
            self._label.configure(cursor="hand2" if self._enabled else "arrow")
        if "fg" in kw:
            self._label.configure(fg=kw.pop("fg"))
        if "bg" in kw:
            self._bg = kw.pop("bg")
            super().configure(bg=self._bg)
            self._label.configure(bg=self._bg)
        if kw:
            super().configure(**kw)
        self._sync()

    config = configure


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


# ---------------- 后台服务：状态记录与关闭 ----------------
#
# 浏览器 / 端口模式下启动器不退出，服务是它的子进程；关掉启动器窗口不代表
# 关掉服务（后台继续跑）。所以把「谁在跑」写进 state 文件，下次打开启动器
# 也能认出来，并从「关闭服务」按钮把整棵进程树收掉。

def load_state() -> dict:
    try:
        st = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(st: dict) -> None:
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def clear_state() -> None:
    try:
        STATE_PATH.unlink()
    except OSError:
        pass


def _service_pids(port: int) -> list[str]:
    """监听该端口的 PID（netstat 解析）。"""
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True, text=True, encoding=_CMD_ENCODING, errors="replace",
            timeout=5, creationflags=CREATE_NO_WINDOW,
        ).stdout or ""
    except Exception:
        return []
    pids: list[str] = []
    for line in out.splitlines():
        if f":{port} " in line and "LISTENING" in line:
            parts = line.split()
            if parts and parts[-1].isdigit() and parts[-1] not in pids:
                pids.append(parts[-1])
    return pids


def stop_service_on_port(port: int) -> tuple[int, str]:
    """关掉该端口上的 Texture 服务。返回 (关闭数量, 说明)。

    只动 Texture 自己：先确认 /api/roots 能应答，避免把别人的服务叉掉。
    """
    if not port_in_use(port):
        return 0, "端口上没有服务在运行"
    if not is_texture(port):
        return 0, f"端口 {port} 上的程序不是 Texture，未做任何操作"
    pids = _service_pids(port)
    if not pids:
        return 0, "没有找到监听进程（可能刚退出）"
    killed = 0
    for pid in pids:
        try:
            r = subprocess.run(["taskkill", "/F", "/T", "/PID", pid],
                               capture_output=True, timeout=8,
                               creationflags=CREATE_NO_WINDOW)
            if r.returncode == 0:
                killed += 1
        except Exception:
            pass
    return killed, (f"已关闭 {killed} 个进程" if killed else "关闭失败，可能已被手动结束")


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
    def __init__(self, auto: bool = False) -> None:
        super().__init__()
        cfg = load_config()
        self.cfg = cfg
        self._auto = bool(auto)      # 上次勾了「记住」：悄悄起完就退，不露面
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
        self._running: dict | None = None      # 后台服务在跑时的记录
        self._child: subprocess.Popen | None = None

        self.title("Texture 启动器")
        self.configure(bg=BG)
        self.resizable(False, False)
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self._center(644, 590)
        self._build()
        self._sync_mode()
        self.update_idletasks()
        self._fit()
        self._decorate()
        if self._auto:
            self.withdraw()          # 先藏起来：起不来再露面
        self.bind("<Return>", lambda e: self._primary())
        self.bind("<Escape>", lambda e: self.destroy())
        # 窗口先画出来再检测：端口探测几乎瞬时，解释器探测可能要 1–2 秒
        self.after(60, self._check_port)
        self.after(140, self._check_env)
        self.after(200, self._check_running)
        self.after(320, self._autostart)

    # -- 布局 --
    def _center(self, w: int, h: int) -> None:
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"{w}x{h}+{(sw - w) // 2}+{max(0, (sh - h) // 2 - 40)}")

    def _fit(self) -> None:
        """按内容实际尺寸定窗口大小。

        不同 DPI / 字体下同样的像素高度差别很大，写死高度会把最后一段（选项）
        裁在可视区外——pack 先到先得，body 在底部栏之后，被挤掉的总是它的末尾。
        """
        try:
            w = max(644, self.winfo_reqwidth())
            h = self.winfo_reqheight()
        except tk.TclError:
            return
        self._center(w, h)

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
        init_fonts()
        # 顶部命令栏：两套主题都是深色，和主界面同一处开始
        bar = tk.Frame(self, bg=BAR, height=78)
        bar.pack(fill="x")
        bar.pack_propagate(False)
        seal = tk.Frame(bar, bg=SIGNAL, width=26, height=26)
        seal.pack(side="left", padx=(20, 12), pady=26)
        seal.pack_propagate(False)
        tk.Label(seal, text="T", bg=SIGNAL, fg=INK,
                 font=(LAT, 13, "bold")).place(relx=0.5, rely=0.5, anchor="center")
        word = tk.Frame(bar, bg=BAR)
        word.pack(side="left", pady=13)
        tk.Label(word, text="TEXTURE", bg=BAR, fg="#ffffff",
                 font=(LAT, 15, "bold")).pack(anchor="w")
        tk.Label(word, text="本地图片库 · 启动器", bg=BAR, fg="#8b8b83",
                 font=(ZH, 8)).pack(anchor="w")
        tk.Label(bar, text="// LAUNCHER", bg=BAR, fg="#8b8b83",
                 font=(LAT, 9)).pack(side="right", padx=20)

        # 三色条：和主界面顶部同一套，表示"屏幕从这里开始"
        strip = tk.Frame(self, bg=BAR, height=3)
        strip.pack(fill="x")
        for color in ("#ff00f0", SIGNAL, "#00ffa2"):
            tk.Frame(strip, bg=color, height=3).pack(side="left", fill="both",
                                                     expand=True)

        # 底部先占位再装内容：pack 按顺序分配空间，先占住才不会被内容挤出去
        foot = tk.Frame(self, bg=BG)
        foot.pack(fill="x", side="bottom", padx=22, pady=(0, 16))

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True, padx=22, pady=(2, 0))

        # 01 启动方式：三条记录行，当前项左侧落一条黄线
        self._section(body, "01", "启动方式", "LAUNCH MODE")
        modes = tk.Frame(body, bg=BG)
        modes.pack(fill="x", pady=(0, 2))
        for i, key in enumerate(("native", "web", "port")):
            self._cards[key] = self._make_card(modes, key, i + 1)
            self._cards[key]["row"].pack(fill="x", pady=(0, 1))

        # 02 端口与地址
        self._section(body, "02", "端口与地址", "ENDPOINT")
        form = tk.Frame(body, bg=BG)
        form.pack(fill="x", pady=(6, 0))
        form.grid_columnconfigure(1, weight=1)

        tk.Label(form, text="端口", bg=BG, fg=INK, font=(ZH, 9, "bold"),
                 width=4, anchor="w").grid(row=0, column=0, sticky="w", pady=(0, 6))
        self.port_entry = tk.Entry(form, textvariable=self.port_text, width=6,
                                   font=(MONO, 12, "bold"), bg=CARD, fg=INK,
                                   relief="flat", justify="center",
                                   highlightthickness=1, highlightbackground=RULE,
                                   highlightcolor=INK, insertbackground=INK)
        self.port_entry.grid(row=0, column=1, sticky="w", ipady=5)
        self.port_entry.bind("<KeyRelease>", self._on_port_input)

        port_right = tk.Frame(form, bg=BG)
        port_right.grid(row=0, column=2, sticky="e", pady=(0, 6))
        self.port_badge = tk.Label(port_right, text="", bg=BG, fg=MUTED,
                                   font=(ZH, 9), anchor="e")
        self.port_badge.pack(side="left", padx=(0, 10))
        CutButton(port_right, "换一个", self._auto_port, width=74, height=28,
                  bg=BG, cut=9, font=(ZH, 8)).pack(side="left")

        tk.Frame(form, bg=RULE, height=1).grid(row=1, column=0, columnspan=3,
                                              sticky="ew", pady=(2, 8))

        tk.Label(form, text="地址", bg=BG, fg=INK, font=(ZH, 9, "bold"),
                 width=4, anchor="w").grid(row=2, column=0, sticky="w")
        host_row = tk.Frame(form, bg=BG)
        host_row.grid(row=2, column=1, sticky="w")
        self.host_entry = tk.Entry(host_row, textvariable=self.host, width=14,
                                   font=(MONO, 10), bg=CARD, fg=INK, relief="flat",
                                   highlightthickness=1, highlightbackground=RULE,
                                   highlightcolor=INK, insertbackground=INK)
        self.host_entry.pack(side="left", ipady=4)
        # 分段选择：当前段墨底反白（不用黄，黄只留给"当前所在"这种强标记）
        self._host_seg: dict[str, tk.Label] = {}
        seg = tk.Frame(host_row, bg=RULE, padx=1, pady=1)
        seg.pack(side="left", padx=(8, 0))
        for label, value in (("本机", "127.0.0.1"), ("局域网", "0.0.0.0")):
            b = tk.Label(seg, text=label, bg=BG, fg=INK, font=(ZH, 8),
                         padx=9, pady=3, cursor="hand2")
            b.pack(side="left", padx=(0, 1))
            b.bind("<Button-1>", lambda _e, v=value: self._set_host(v))
            self._host_seg[value] = b
        self.host_hint = tk.Label(form, text="", bg=BG, fg=MUTED, font=(ZH, 9),
                                  anchor="e")
        self.host_hint.grid(row=2, column=2, sticky="e")
        self.host.trace_add("write", lambda *_: self._sync_host_hint())

        # 底部：状态一行；下面一行左边是勾选项，右边三个等宽按钮
        tk.Frame(foot, bg=RULE, height=1).pack(fill="x", pady=(0, 8))
        info = tk.Frame(foot, bg=BG)
        info.pack(fill="x", pady=(0, 10))
        self.status = tk.Label(info, text="", bg=BG, fg=MUTED, font=(ZH, 9),
                               anchor="w")
        self.status.pack(side="left")
        self.env_label = tk.Label(info, text="检测运行环境…", bg=BG, fg=MUTED,
                                  font=(ZH, 8), anchor="e")
        self.env_label.pack(side="right")

        btns = tk.Frame(foot, bg=BG)
        btns.pack(fill="x")
        # 三个按钮同规格：104×36、同一切角，只靠填充区分主次
        self.stop_btn = CutButton(btns, "关闭服务", self.stop_service, width=104,
                                  height=36, bg=BG, cut=12, font=(ZH, 9))
        self.stop_btn.configure(state="disabled", fg="#b3b3ab")
        self.stop_btn.pack(side="right", padx=(0, 8))
        CutButton(btns, "退出", self.destroy, width=104, height=36, bg=BG,
                  cut=12, font=(ZH, 9)).pack(side="right", padx=(0, 8))
        self.launch_btn = CutButton(btns, "启动", self._primary, width=104,
                                    height=36, primary=True, cut=12,
                                    font=(ZH, 9, "bold"))
        self.launch_btn.pack(side="right", padx=(0, 10))
        self.debug_chk = Toggle(btns, "开发者工具", self.debug, bg=BG,
                                command=self._sync_mode)
        self.debug_chk.pack(side="left")
        self._remember_chk = Toggle(btns, "记住这次选择", self.remember, bg=BG)
        self._remember_chk.pack(side="left", padx=(18, 0))

    def _section(self, parent: tk.Frame, num: str, zh: str, en: str) -> None:
        """小节标题：// 编号 + 中英成对，下面一条细线。"""
        row = tk.Frame(parent, bg=BG)
        row.pack(fill="x", pady=(13, 5))
        tk.Label(row, text="//", bg=BG, fg=MUTED, font=(LAT, 8)).pack(side="left")
        tk.Label(row, text=num, bg=BG, fg=MUTED, font=(MONO, 8)).pack(
            side="left", padx=(5, 9))
        tk.Label(row, text=zh, bg=BG, fg=INK, font=(ZH, 9, "bold")).pack(side="left")
        tk.Label(row, text=en, bg=BG, fg=MUTED, font=(LAT_L, 8)).pack(side="right")
        tk.Frame(parent, bg=RULE, height=1).pack(fill="x")

    def _make_card(self, parent: tk.Frame, key: str, num: int) -> dict:
        icon, title, sub = MODES[key]
        row = tk.Frame(parent, bg=CARD, cursor="hand2")
        trace = tk.Frame(row, bg=CARD, width=3)
        trace.pack(side="left", fill="y")
        inner = tk.Frame(row, bg=CARD, cursor="hand2")
        inner.pack(side="left", fill="both", expand=True, padx=(11, 12), pady=8)
        idx = tk.Label(inner, text=f"{num:02d}", bg=CARD, fg="#b0b0a8",
                       font=(MONO, 9), cursor="hand2")
        idx.pack(side="left", padx=(0, 10))
        # 图标留在中文族里：▣ ◎ ⌗ 这些几何字 Bahnschrift 里没有，换个字体会出豆腐块
        ico = tk.Label(inner, text=icon, bg=CARD, fg=MUTED, font=(ZH, 13),
                       cursor="hand2", width=2, anchor="w")
        ico.pack(side="left")
        text = tk.Frame(inner, bg=CARD, cursor="hand2")
        text.pack(side="left", fill="x", expand=True, padx=(6, 0))
        name = tk.Label(text, text=title, bg=CARD, fg=INK, font=(ZH, 10, "bold"),
                        cursor="hand2", anchor="w")
        name.pack(anchor="w")
        desc = tk.Label(text, text=sub, bg=CARD, fg=MUTED, font=(ZH, 8),
                        cursor="hand2", anchor="w")
        desc.pack(anchor="w")
        mark = tk.Frame(inner, width=10, height=10, bg=CARD,
                        highlightthickness=1, highlightbackground=RULE)
        mark.pack(side="right", padx=(8, 0))
        mark.pack_propagate(False)
        for w in (row, trace, inner, idx, ico, text, name, desc, mark):
            w.bind("<Button-1>", lambda _e, k=key: self._pick(k))
        for w in (row, trace, inner, text, idx, ico, name, desc, mark):
            w.bind("<Enter>", lambda _e, r=row: self._hover_card(r, True))
            w.bind("<Leave>", lambda _e, r=row: self._hover_card(r, False))
        return {"row": row, "trace": trace, "idx": idx, "icon": ico,
                "name": name, "desc": desc, "mark": mark, "frame": row,
                "bgs": (row, trace, inner, idx, ico, text, name, desc, mark)}

    def _hover_card(self, row: tk.Frame, on: bool) -> None:
        # 悬停只提亮一档底色，不动文字，避免看起来像被选中。
        # 内层 Frame 铺满整行，所以底色得逐个刷，光改容器看不出变化。
        current = self.mode.get()
        for key, parts in self._cards.items():
            if parts["row"] is row and key != current:
                bg = "#f7f7f4" if on else CARD
                for w in parts["bgs"]:
                    w.configure(bg=bg)

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
        current = self.mode.get()
        for key, parts in self._cards.items():
            on = key == current
            for w in parts["bgs"]:
                w.configure(bg=CARD)
            parts["trace"].configure(bg=SIGNAL if on else CARD)
            parts["mark"].configure(bg=SIGNAL if on else CARD,
                                    highlightbackground=INK if on else RULE)
            parts["idx"].configure(fg=INK if on else "#b0b0a8")
            parts["icon"].configure(fg=INK if on else MUTED)
            parts["name"].configure(fg=INK)
            parts["desc"].configure(fg=MUTED)
        if not HAS_WEBVIEW:
            self._cards["native"]["desc"].configure(text="未安装 pywebview", fg=BAD)
        state = "normal" if current == "native" else "disabled"
        self.debug_chk.configure(state=state)
        self._sync_host_hint()
        self._sync_summary()
    def _sync_summary(self) -> None:
        if self._busy:
            return
        if self._running:
            # 服务在跑时这一行留给「运行中」状态，别被端口输入盖掉
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
        # 分段选择跟着输入框走：手打了 0.0.0.0 也要跟着亮
        for value, lbl in getattr(self, "_host_seg", {}).items():
            on = host == value
            lbl.configure(bg=INK if on else BG, fg="#ffffff" if on else INK)
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
        if self._running and port == self._running.get("port"):
            self.port_badge.configure(text="● 本实例正在此端口运行", fg=OK)
            return
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
        # 每次启动都落盘：记住与否只是一个开关，下次要不要静默启动看它
        save_config({"mode": cfg["mode"], "host": cfg["host"],
                     "port": cfg["port"], "remember": bool(cfg["remember"]),
                     "debug": cfg["debug"], "python": self.python_exe or ""})
        cmd = build_cmd(cfg["mode"], cfg["host"], cfg["port"], cfg["debug"],
                        self.python_exe)
        self._busy = True
        self.launch_btn.configure(state="disabled", text="启动中")
        self.status.configure(text="正在启动服务…", fg=MUTED)
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            log = open(LOG_PATH, "ab", buffering=0)
            log.write(f"\n===== {cfg['mode']} {cfg['host']}:{cfg['port']}{os.linesep}"
                      .encode("utf-8"))
            flags = 0
            if sys.platform == "win32":
                flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            self._child = subprocess.Popen(cmd, cwd=str(BASE), stdout=log,
                                           stderr=subprocess.STDOUT,
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
        if cfg["mode"] == "native":
            # 桌面模式：原生窗口自己显示内容，启动器没用了，关掉即可
            self.destroy()
            return
        if cfg["mode"] == "port":
            try:
                self.clipboard_clear()
                self.clipboard_append(url)
            except tk.TclError:
                pass
        if self._auto:
            # 静默启动：浏览器模式顺手打开页面，端口模式只留服务，窗口直接退
            if cfg["mode"] == "web":
                import webbrowser
                webbrowser.open(url)
            save_state({"mode": cfg["mode"], "host": cfg["host"],
                        "port": cfg["port"], "url": url})
            self.destroy()
            return
        # 浏览器 / 端口模式：窗口留在前台当控制台，服务继续在后台跑
        self._set_running(cfg, url)

    # -- 静默启动 --
    def _autostart(self) -> None:
        """上次勾了「记住这次选择」：照存下来的方式直接起，启动器不露面。

        任何一步走不通（端口被占、依赖缺、已经在跑）就把窗口亮出来，
        否则用户只会看到「双击了没反应」。
        """
        if not self._auto:
            return
        try:
            port = int(self.port_text.get())
        except ValueError:
            self._reveal("保存的端口无效，请重新选择"); return
        mode = self.mode.get()
        host = self.host.get().strip() or "127.0.0.1"
        if mode == "native" and not HAS_WEBVIEW:
            self._reveal("桌面模式不可用：未安装 pywebview"); return
        state, text = port_state(port, host)
        if state == "texture":
            # 服务本来就在跑：桌面模式退掉即可，其余模式把界面打开
            self._reveal("已有 Texture 在运行"); return
        if state != "free":
            self._reveal(text); return
        if not self.deps_ok:
            self._reveal("依赖未安装"); return
        self.launch()

    def _reveal(self, note: str = "") -> None:
        """静默启动失败时把窗口摆出来，并说明卡在哪一步。"""
        self._auto = False
        try:
            self.deiconify()
            self.lift()
            self.focus_force()
        except tk.TclError:
            return
        self.update_idletasks()
        self._fit()
        if note:
            self.status.configure(text=note, fg=BAD)

    # -- 运行态 --
    def _set_running(self, cfg: dict, url: str) -> None:
        self._busy = False
        self._running = {"mode": cfg["mode"], "host": cfg["host"],
                         "port": cfg["port"], "url": url}
        save_state(self._running)
        self.mode.set(cfg["mode"])
        self.port_text.set(str(cfg["port"]))
        self.host.set(cfg["host"])
        self._sync_mode()
        self.launch_btn.configure(state="normal", text="打开界面")
        self.stop_btn.configure(state="normal", fg=BAD)
        self.status.configure(text=f"● 服务运行中 · {url}", fg=OK)

    def _check_running(self) -> None:
        """上次留下的服务还在跑？直接在窗口里显示成运行态。"""
        st = load_state()
        port = st.get("port")
        if not isinstance(port, int) or not (1000 <= port <= 9999):
            clear_state()
            return
        if port_in_use(port) and is_texture(port):
            url = st.get("url") or f"http://127.0.0.1:{port}"
            self._set_running({"mode": st.get("mode") or "port",
                               "host": st.get("host") or "127.0.0.1",
                               "port": port}, url)
        else:
            clear_state()

    def _primary(self) -> None:
        """主按钮：没在跑就启动，在跑就打开界面。"""
        if self._running:
            self.open_ui()
        else:
            self.launch()

    def open_ui(self) -> None:
        url = (self._running or {}).get("url") or ""
        if not url:
            return
        mode = (self._running or {}).get("mode")
        if mode == "port":
            try:
                self.clipboard_clear()
                self.clipboard_append(url)
            except tk.TclError:
                pass
            messagebox.showinfo("地址已复制", f"{url}\n\n已复制到剪贴板，用任意浏览器打开即可。")
            return
        import webbrowser
        webbrowser.open(url)
        self.status.configure(text=f"已在浏览器打开 · {url}", fg=MUTED)

    def stop_service(self) -> None:
        """关掉后台服务（整棵进程树），启动器本身保持打开。"""
        st = self._running or load_state()
        port = st.get("port") if isinstance(st, dict) else None
        if not isinstance(port, int):
            clear_state()
            self._reset_idle()
            return
        if not messagebox.askokcancel(
                "关闭后台服务",
                f"关闭 {port} 端口上的 Texture 服务？\n\n"
                "正在运行的界面会断开，未保存的画板改动可能丢失。"):
            return
        killed, msg = stop_service_on_port(port)
        if self._child is not None:
            try:
                self._child.wait(timeout=1.5)
            except Exception:
                pass
        clear_state()
        self._reset_idle()
        self.status.configure(text=msg, fg=OK if killed else BAD)
        messagebox.showinfo("已关闭" if killed else "未能关闭", msg)
        self._check_port()

    def _reset_idle(self) -> None:
        self._running = None
        self._child = None
        self._busy = False
        self.stop_btn.configure(state="disabled", fg="#c9c9c1")
        self.launch_btn.configure(state="normal", text="启动")

    def _fail(self, msg: str) -> None:
        self._busy = False
        self._reveal()                     # 静默启动失败：把窗口摆出来再报错
        self.launch_btn.configure(state="normal", text="启动")
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


def shift_held() -> bool:
    """按住 Shift 打开启动器：强制显示窗口，用来改回设置。"""
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        return bool(ctypes.windll.user32.GetAsyncKeyState(0x10) & 0x8000)
    except Exception:
        return False


def should_autostart() -> bool:
    """上次勾了「记住这次选择」就不再摆窗口，直接按那次的方式启动。"""
    if shift_held() or "--ui" in sys.argv:
        return False
    if not CONFIG_PATH.exists():
        return False
    return bool(load_config().get("remember"))


def main() -> None:
    enable_dpi_awareness()
    code = 0
    try:
        Launcher(auto=should_autostart()).mainloop()
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
