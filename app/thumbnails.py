"""缩略图生成与磁盘缓存（按尺寸分文件：{fid}_{size}.jpg）。"""
import hashlib
from pathlib import Path

from PIL import Image

from .store import DATA_DIR

THUMB_DIR = DATA_DIR / "thumbs"
THUMB_SIZE = 512
ALLOWED_SIZES = {256, 512}   # 256 给网格/抽屉，512 给画板


def thumb_path(fid: str, size: int = THUMB_SIZE) -> Path:
    return THUMB_DIR / f"{fid}_{size}.jpg"


def get_thumbnail(src: Path, fid: str, size: int = THUMB_SIZE) -> Path:
    """返回缩略图路径，无缓存则生成。透明背景合成到白底，避免黑块。"""
    size = size if size in ALLOWED_SIZES else THUMB_SIZE
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    tp = thumb_path(fid, size)
    if tp.exists():
        return tp
    with Image.open(src) as img:
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[3])
            img = bg
        else:
            img = img.convert("RGB")
        img.thumbnail((size, size))
        img.save(tp, "JPEG", quality=82)
    return tp
