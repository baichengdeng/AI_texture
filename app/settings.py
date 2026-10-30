"""数据目录定位 + 存储目录迁移。

「其他数据的存储位置」不能存进数据库本身（否则换个位置就找不到库了），
所以固定放在项目的 data/bootstrap.json 里当指针：

    {"data_dir": "D:/TextureData"}

没有这个文件、或指向的目录不可用时，回退到项目自带的 data/。
改动只在下次启动生效（当前进程已经打开了旧的 sqlite 连接）。
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DEFAULT_DATA = BASE / "data"
BOOTSTRAP = DEFAULT_DATA / "bootstrap.json"

# 跟着数据库走的东西：库本身 + 缩略图缓存
MIGRATE_ITEMS = ("texture.db", "thumbs")


def _read_bootstrap() -> dict:
    try:
        cfg = json.loads(BOOTSTRAP.read_text(encoding="utf-8"))
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def data_dir() -> Path:
    """当前生效的数据目录（数据库、缩略图、画板导出的落点）。"""
    raw = str(_read_bootstrap().get("data_dir") or "").strip()
    if raw:
        p = Path(raw).expanduser()
        try:
            if p.is_dir() and p != DEFAULT_DATA:
                return p
        except OSError:
            pass
    return DEFAULT_DATA


DATA_DIR = data_dir()


def write_bootstrap(target: Path) -> None:
    """写入指针文件；指回默认目录时直接删掉文件，保持干净。"""
    try:
        DEFAULT_DATA.mkdir(parents=True, exist_ok=True)
        if Path(target).resolve() == DEFAULT_DATA.resolve():
            BOOTSTRAP.unlink(missing_ok=True)
            return
        BOOTSTRAP.write_text(
            json.dumps({"data_dir": str(Path(target).resolve())}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as e:
        raise ValueError(f"无法写入位置配置：{e}")


def migrate_data(target: Path) -> dict:
    """把数据库与缩略图复制到新目录。

    只复制不移动：旧目录留着当备份，确认没问题后用户可以自己删。
    返回 {"copied": [...], "db": bool, "thumbs": int}。
    """
    target = Path(target).expanduser()
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise ValueError(f"目标目录不可写：{e}")
    if not _writable(target):
        raise ValueError(f"目标目录不可写：{target}")

    src = DATA_DIR
    copied, thumbs = [], 0
    db = src / "texture.db"
    if db.is_file():
        try:
            shutil.copy2(db, target / "texture.db")
            copied.append("texture.db")
        except OSError as e:
            raise ValueError(f"复制数据库失败：{e}")
    src_thumbs = src / "thumbs"
    if src_thumbs.is_dir():
        dst_thumbs = target / "thumbs"
        dst_thumbs.mkdir(parents=True, exist_ok=True)
        for f in src_thumbs.iterdir():
            if not f.is_file():
                continue
            try:
                shutil.copy2(f, dst_thumbs / f.name)
                thumbs += 1
            except OSError:
                pass
    write_bootstrap(target)
    return {"copied": copied, "db": db.is_file(), "thumbs": thumbs}


def _writable(p: Path) -> bool:
    probe = p / ".texture-write-test"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False
