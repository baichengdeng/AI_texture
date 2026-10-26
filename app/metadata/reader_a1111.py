"""
读取器 1/3：A1111 (Stable Diffusion WebUI) 元数据。

- PNG：tEXt 块 `parameters`（人类可读文本）
- JPEG/WebP：EXIF UserComment 内同格式文本

解析逻辑照搬自 receyuki/stable-diffusion-prompt-reader（MIT）format/a1111.py，
EXIF 读取参考其 image_data_reader.py（piexif 优先，PIL 兜底）。

独立测试：python -m app.metadata.reader_a1111 <图片路径>
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image

from ._shared import BaseFormat


class A1111(BaseFormat):
    PROMPT_MAPPING = {
        "Seed": ("seed", False),
        "Variation seed strength": ("subseed_strength", False),
        "Sampler": ("sampler_name", True),
        "Steps": ("steps", False),
        "CFG scale": ("cfg_scale", False),
        "Face restoration": ("restore_faces", False),
    }

    SETTING_KEY = ["Model", "Sampler", "Seed", "CFG scale", "Steps", "Size"]

    def __init__(self, info: dict = None, raw: str = "", width: int = 0, height: int = 0):
        super().__init__(info, raw, width, height)
        self._extra = ""

    def _process(self):
        if not self._raw:
            self._raw = self._info.get("parameters", "")
            self._extra = self._info.get("postprocessing", "")
        self._sd_format()

    def _sd_format(self):
        if not self._raw and not self._extra:
            return

        steps_index = self._raw.find("\nSteps:")
        # w/ setting
        if steps_index != -1:
            self._positive = self._raw[:steps_index].strip()
            self._setting = self._raw[steps_index:].strip()

        # w/ neg
        if "Negative prompt:" in self._raw:
            prompt_index = self._raw.find("\nNegative prompt:")
            # w/ neg and w/ setting
            if steps_index != -1:
                self._negative = self._raw[
                    prompt_index + len("Negative prompt:") + 1 : steps_index
                ].strip()
            # w/ neg and w/o setting
            else:
                self._negative = self._raw[
                    prompt_index + len("Negative prompt:") + 1 :
                ].strip()
            self._positive = self._raw[:prompt_index].strip()
        # w/o neg and w/o setting
        elif steps_index == -1:
            self._positive = self._raw

        # match parameters like "Steps: x"
        pattern = r"\s*([^:,]+):\s*([^,]+)"
        matches = re.findall(pattern, self._setting)
        setting_dict = {}
        for key, value in matches:
            if key not in setting_dict:
                setting_dict[key] = value

        try:
            [self._width, self._height] = setting_dict.get("Size", "0x0").split("x")
        except ValueError:
            self._width, self._height = "0", "0"

        for p, s in zip(BaseFormat.PARAMETER_KEY, A1111.SETTING_KEY):
            self._parameter[p] = setting_dict.get(s)


def extract_user_comment(img: Image.Image) -> str:
    """从 JPEG/WebP 的 EXIF UserComment (0x9286) 提取文本。"""
    # piexif 路线（与 SD Prompt Reader 一致）
    try:
        import piexif
        import piexif.helper

        exif = piexif.load(img.info.get("exif")) or {}
        uc = (exif.get("Exif") or {}).get(piexif.ExifIFD.UserComment)
        if uc:
            return piexif.helper.UserComment.load(uc)
    except ImportError:
        pass
    except Exception:
        pass
    # PIL 兜底
    try:
        ifd = img.getexif().get_ifd(0x8769)  # Exif IFD
        uc = ifd.get(0x9286)
        if isinstance(uc, (bytes, bytearray)) and len(uc) > 8:
            head, body = bytes(uc[:8]), bytes(uc[8:])
            if head.startswith(b"UNICODE"):
                if body[:2] in (b"\xff\xfe", b"\xfe\xff"):
                    return body[2:].decode("utf-16", "ignore")
                return body.decode("utf-16-le", "ignore")
            return body.decode("utf-8", "ignore")
        if isinstance(uc, str):
            return uc
    except Exception:
        pass
    return ""


def read(path) -> dict:
    """读取单张图片，仅尝试 A1111 格式。返回统一元数据 dict。"""
    p = Path(path)
    with Image.open(p) as f:
        fmt = (f.format or "").upper()
        info = dict(f.info)
        width, height = f.size
    raw = info.get("parameters", "")
    if not raw and fmt in ("JPEG", "JPG", "WEBP"):
        with Image.open(p) as f:
            raw = extract_user_comment(f)
        info = {"parameters": raw}
    if not raw and not info.get("postprocessing"):
        return BaseFormat(info).to_dict("a1111", "A1111 webUI", ok=False)
    parser = A1111(info=info, raw=raw, width=width, height=height)
    parser.parse()
    return parser.to_dict(
        "a1111",
        "A1111 webUI",
        extra={"postprocessing": info.get("postprocessing", "")},
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    print(json.dumps(read(sys.argv[1]), ensure_ascii=False, indent=2))
