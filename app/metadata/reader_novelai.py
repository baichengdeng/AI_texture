"""
读取器 3/3：NovelAI 元数据。

- 标准格式：PNG tEXt 块 Title/Description/Software/Source/Comment
  （Description=提示词，Comment=参数 JSON 字符串，V4 系含 char_prompts 等）
- Stealth 隐写格式：RGBA alpha 通道 LSB 位流（列序遍历），
  魔数 "stealth_pngcomp" + 32 位长度头（位计）+ gzip 压缩 JSON

解析逻辑照搬自 receyuki/stable-diffusion-prompt-reader（MIT）format/novelai.py。
LSBExtractor 改为 numpy 实现（接口不变，快约两个数量级），
并修复了原实现遇到 0x00 字节提前截断的问题。
embed_stealth() 为本项目新增（生成测试图 / 元数据写回用）。

独立测试：python -m app.metadata.reader_novelai <图片路径>
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from ._shared import BaseFormat, remove_quotes

NOVELAI_MAGICS = {"stealth_pngcomp": True, "stealth_pnginfo": False}  # 魔数 → 是否 gzip


class LSBExtractor:
    """alpha 通道 LSB 位流读取器（列序：先沿行向下，再到下一列）。"""

    def __init__(self, img: Image.Image):
        alpha = np.asarray(img.convert("RGBA"))[:, :, 3]
        bits = (alpha.T & 1).reshape(-1)  # 转置后展平 = 列序遍历
        self._data = np.packbits(bits).tobytes()  # MSB 在前，与原实现一致
        self._pos = 0

    def get_one_byte(self) -> bytearray:
        if self._pos >= len(self._data):
            return bytearray()
        b = self._data[self._pos]
        self._pos += 1
        return bytearray([b])

    def get_next_n_bytes(self, n: int) -> bytearray:
        out = bytearray()
        for _ in range(n):
            b = self.get_one_byte()
            if not b and self._pos >= len(self._data):
                break
            out.extend(b)
        return out

    def read_32bit_integer(self):
        bytes_list = self.get_next_n_bytes(4)
        if len(bytes_list) == 4:
            return int.from_bytes(bytes_list, byteorder="big")
        return None


class NovelAI(BaseFormat):
    SETTING_KEY_LEGACY = [
        "",
        "sampler",
        "seed",
        "scale",
        "steps",
        "",
    ]

    SETTING_KEY_STEALTH = ["Source", "sampler", "seed", "scale", "steps", ""]

    def __init__(
        self,
        info: dict = None,
        raw: str = "",
        extractor: LSBExtractor = None,
        width: int = 0,
        height: int = 0,
        compressed: bool = True,
    ):
        super().__init__(info, raw, width, height)
        self._extractor = extractor
        self._compressed = compressed

    def _process(self):
        if self._info:
            self._nai_legacy()
        elif self._extractor:
            self._nai_stealth()

    def _nai_legacy(self):
        self._positive = (self._info.get("Description") or "").strip()
        self._raw += self._positive
        data = self._info.get("Comment") or "{}"
        data_json = json.loads(data)
        self._negative = (data_json.get("uc") or "").strip()
        self._raw += "\n".join([self._positive, self._negative, str(data_json)]).strip()

        data_json.pop("uc", None)
        self._setting = remove_quotes(str(data_json)).strip("{ }")

        for p, s in zip(BaseFormat.PARAMETER_KEY, NovelAI.SETTING_KEY_LEGACY):
            match p:
                case "model":
                    self._parameter["model"] = str(self._info.get("Source") or "")
                case "size":
                    self._parameter["size"] = f"{self._width}x{self._height}"
                case _:
                    self._parameter[p] = str(data_json.get(s))

    def _nai_stealth(self):
        read_len = self._extractor.read_32bit_integer() // 8
        raw_bytes = bytes(self._extractor.get_next_n_bytes(read_len))
        json_data = json.loads(
            gzip.decompress(raw_bytes).decode("utf-8") if self._compressed
            else raw_bytes.decode("utf-8")
        )
        self._raw = str(json_data)
        if "Comment" in json_data:
            json_data = json_data | json.loads(json_data["Comment"])
            json_data.pop("Comment")
            self._positive = json_data.get("prompt").strip()
            json_data.pop("prompt")
            self._negative = json_data.get("uc").strip()
            json_data.pop("uc")
        else:
            self._positive = json_data.get("Description").strip()
        json_data.pop("Description", None)
        self._setting = remove_quotes(str(json_data)).strip("{ }")
        for p, s in zip(BaseFormat.PARAMETER_KEY, NovelAI.SETTING_KEY_STEALTH):
            match p:
                case "size":
                    self._parameter["size"] = (
                        str(json_data.get("width")) + "x" + str(json_data.get("height"))
                    )
                case _:
                    self._parameter[p] = str(json_data.get(s))


def try_stealth(img: Image.Image):
    """检测并消耗 stealth 魔数。命中返回 (extractor, compressed)，否则 None。
    同时支持压缩 (stealth_pngcomp) 与未压缩 (stealth_pnginfo) 两种变体。"""
    try:
        reader = LSBExtractor(img)
        magic = bytes(reader.get_next_n_bytes(15)).decode("utf-8", "ignore")
        if magic not in NOVELAI_MAGICS:
            return None
        return reader, NOVELAI_MAGICS[magic]
    except Exception:
        return None


def embed_stealth(img: Image.Image, payload: dict, compressed: bool = True) -> Image.Image:
    """把 payload(dict) 以 NovelAI stealth 格式写入 alpha LSB（列序）。
    compressed=False 为未压缩 stealth_pnginfo 变体。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if compressed:
        body = gzip.compress(body)
        stream = "stealth_pngcomp".encode("utf-8")
    else:
        stream = "stealth_pnginfo".encode("utf-8")
    stream = stream + (len(body) * 8).to_bytes(4, "big") + body  # 32 位头为「位数」
    bits = np.frombuffer(stream, dtype=np.uint8)
    bits = np.unpackbits(bits)
    arr = np.asarray(img.convert("RGBA")).copy()
    h, w = arr.shape[:2]
    if bits.size > h * w:
        raise ValueError(f"图片太小，装不下隐写数据（需要 {bits.size} 位，只有 {h*w} 位）")
    alpha = arr[:, :, 3]
    flat = alpha.T.reshape(-1)  # 列序
    flat[: bits.size] = (flat[: bits.size] & 0xFE) | bits.astype(np.uint8)
    alpha.T[:] = flat.reshape(w, h)
    return Image.fromarray(arr, "RGBA")


def read(path) -> dict:
    """读取单张图片，仅尝试 NovelAI 格式（标准 tEXt + stealth 隐写）。"""
    p = Path(path)
    with Image.open(p) as f:
        info = dict(f.info)
        width, height = f.size
        mode = f.mode
        img_rgba = f.convert("RGBA") if mode == "RGBA" else None
    # 标准 tEXt 格式
    is_nai_text = (
        info.get("Software") == "NovelAI"
        or (info.get("Title") == "AI generated image" and "Description" in info and "Comment" in info)
    )
    if is_nai_text:
        parser = NovelAI(info=info, width=width, height=height)
        parser.parse()
        return parser.to_dict("novelai", "NovelAI")
    # stealth 隐写格式
    if img_rgba is not None:
        hit = try_stealth(img_rgba)
        if hit is not None:
            extractor, compressed = hit
            parser = NovelAI(
                extractor=extractor, width=width, height=height, compressed=compressed
            )
            parser.parse()
            return parser.to_dict(
                "novelai", "NovelAI (stealth)", extra={"stealth": True}
            )
    return BaseFormat(info).to_dict("novelai", "NovelAI", ok=False)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    print(json.dumps(read(sys.argv[1]), ensure_ascii=False, indent=2))
