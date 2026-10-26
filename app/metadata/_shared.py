"""
共享基类与工具函数。

解析器核心逻辑照搬自 receyuki/stable-diffusion-prompt-reader（MIT License,
Copyright 2023 Rhys Yang, https://github.com/receyuki/stable-diffusion-prompt-reader），
按本项目结构做了最小改动：日志改用标准库、去掉了 UI 依赖，并补充了 to_dict()
统一输出方法。
"""
import json
import logging
from enum import Enum

log = logging.getLogger("texture.metadata")

PARAMETER_KEY = ["model", "sampler", "seed", "cfg", "steps", "size"]


def merge_str_to_tuple(item1, item2):
    if not isinstance(item1, tuple):
        item1 = (item1,)
    if not isinstance(item2, tuple):
        item2 = (item2,)
    return item1 + item2


def merge_dict(dict1, dict2):
    dict3 = dict1.copy()
    for k, v in dict2.items():
        dict3[k] = merge_str_to_tuple(v, dict3[k]) if k in dict3 else v
    return dict3


def remove_quotes(string):
    return str(string).replace('"', "").replace("'", "")


def add_quotes(string):
    return f'"{str(string)}"'


def concat_strings(base, addition, separator=", "):
    return f"{base}{separator}{addition}" if base else addition


class BaseFormat:
    """所有格式解析器的基类（照搬自 sd_prompt_reader/format/base_format.py）"""

    PARAMETER_KEY = PARAMETER_KEY

    def __init__(
        self, info: dict = None, raw: str = "", width: int = 0, height: int = 0
    ):
        self._height = str(height) if height else ""
        self._width = str(width) if width else ""
        self._info = info
        self._positive = ""
        self._negative = ""
        self._positive_sdxl = {}
        self._negative_sdxl = {}
        self._setting = ""
        self._raw = raw
        self._parameter = dict.fromkeys(BaseFormat.PARAMETER_KEY, "")
        self._is_sdxl = False
        self._status = self.Status.UNREAD

    def parse(self):
        try:
            self._process()
        except Exception as e:
            log.error("%s parse error: %s", type(self).__name__, e)
            self._status = self.Status.FORMAT_ERROR
            return self._status
        else:
            self._status = self.Status.READ_SUCCESS
            return self._status

    def _process(self):
        pass

    def to_dict(self, source: str, tool: str, ok: bool = None, extra: dict = None) -> dict:
        """统一元数据输出格式，供接口路由与前端使用。"""
        if ok is None:
            ok = self._status == self.Status.READ_SUCCESS
        params = {k: ("" if v is None else str(v)) for k, v in self._parameter.items()}
        d = {
            "ok": ok,
            "status": self._status.name,
            "source": source,
            "tool": tool,
            "prompt": self._positive or "",
            "negative": self._negative or "",
            "positive_sdxl": self._positive_sdxl,
            "negative_sdxl": self._negative_sdxl,
            "is_sdxl": self._is_sdxl,
            "setting": self._setting or "",
            "params": params,
            "width": str(self._width or ""),
            "height": str(self._height or ""),
            "raw": self._raw or "",
        }
        if extra:
            d.update(extra)
        return d

    @property
    def height(self):
        return self._height

    @property
    def width(self):
        return self._width

    @property
    def positive(self):
        return self._positive

    @property
    def negative(self):
        return self._negative

    @property
    def setting(self):
        return self._setting

    @property
    def raw(self):
        return self._raw

    @property
    def parameter(self):
        return self._parameter

    @property
    def status(self):
        return self._status

    class Status(Enum):
        UNREAD = 1
        READ_SUCCESS = 2
        FORMAT_ERROR = 3
        COMFYUI_ERROR = 4
