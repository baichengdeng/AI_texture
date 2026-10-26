"""
元数据读取包：3 个主力读取器 + 附加格式 + 接口路由。

- reader_a1111.py   A1111 WebUI（PNG tEXt / JPEG·WebP EXIF）
- reader_comfyui.py ComfyUI（prompt/workflow JSON 节点图）
- reader_novelai.py NovelAI（tEXt + stealth alpha 隐写）
- reader_others.py  EasyDiffusion / InvokeAI / Fooocus / SwarmUI / DrawThings
- router.py         接口路由（主软件入口 read_metadata）

解析器核心照搬自 receyuki/stable-diffusion-prompt-reader（MIT）。
"""
from .router import read_metadata

__all__ = ["read_metadata"]
