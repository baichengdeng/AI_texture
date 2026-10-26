"""
接口路由：自动识别图片元数据格式，分发给各读取器，输出统一 dict。

主软件只调用 read_metadata(path)，不直接接触具体读取器。
新增格式时：写 reader_xxx.py（含 read()），在此注册即可。

检测顺序照搬自 receyuki/stable-diffusion-prompt-reader（MIT）image_data_reader.py。

独立测试：python -m app.metadata.router <图片路径>
"""
import json
import sys
from pathlib import Path

from PIL import Image

from ._shared import BaseFormat, log
from .reader_a1111 import A1111, extract_user_comment
from .reader_comfyui import ComfyUI
from .reader_novelai import NovelAI, try_stealth
from .reader_others import EasyDiffusion, InvokeAI, Fooocus, SwarmUI, DrawThings


def _none_result(reason="未找到已知的 AI 元数据格式") -> dict:
    return {
        "ok": False,
        "status": "UNREAD",
        "source": "none",
        "tool": "",
        "prompt": "",
        "negative": "",
        "positive_sdxl": {},
        "negative_sdxl": {},
        "is_sdxl": False,
        "setting": "",
        "params": dict.fromkeys(["model", "sampler", "seed", "cfg", "steps", "size"], ""),
        "width": "",
        "height": "",
        "raw": "",
        "note": reason,
    }


def _parse(parser, source, tool, ok=None, extra=None) -> dict:
    parser.parse()
    return parser.to_dict(source, tool, ok=ok, extra=extra)


def read_metadata(path, stealth: bool = True) -> dict:
    """主软件入口：读取任意图片的 AI 生成元数据，返回统一 dict。

    stealth=False 时跳过 alpha 隐写全像素扫描（扫库时用，量大更快），
    详情接口再以 stealth=True 重读即可补出隐写数据。
    并附真实像素尺寸 pxw/pxh（瀑布流布局预留高度用）。
    """
    result = _read_core(path, stealth)
    try:
        with Image.open(path) as f:
            result["pxw"], result["pxh"] = f.size
    except Exception:
        result["pxw"], result["pxh"] = 0, 0
    return result


def _read_core(path, stealth: bool = True) -> dict:
    p = Path(path)
    with Image.open(p) as f:
        width, height = f.size
        fmt = (f.format or "").upper()
        mode = f.mode
        info = dict(f.info)
        # stealth=True 才整图解码；扫库快路径(stealth=False)只读文本块
        img_rgba = f.convert("RGBA") if (stealth and mode == "RGBA") else None
        exif_model = None
        try:
            exif_model = f.getexif().get(0x0110)
        except Exception:
            pass

    # ---- SwarmUI 旧版（EXIF Model 标签里塞 JSON）----
    try:
        exif_json = json.loads(exif_model)
        if "sui_image_params" in exif_json:
            return _parse(SwarmUI(info=exif_json), "swarmui", "StableSwarmUI")
    except Exception:
        pass

    if fmt == "PNG":
        if "parameters" in info:
            # SwarmUI 兼容 A1111 的格式
            if "sui_image_params" in info.get("parameters", ""):
                return _parse(SwarmUI(raw=info.get("parameters")), "swarmui", "StableSwarmUI")
            # ComfyUI 输出的 A1111 兼容格式
            if "prompt" in info:
                return _parse(
                    A1111(info=info, width=width, height=height),
                    "a1111",
                    "ComfyUI (A1111 兼容)",
                    extra={
                        "prompt_json": info.get("prompt", ""),
                        "workflow_json": info.get("workflow", ""),
                    },
                )
            return _parse(
                A1111(info=info, width=width, height=height),
                "a1111",
                "A1111 webUI",
                extra={"postprocessing": info.get("postprocessing", "")},
            )
        if "postprocessing" in info:
            return _parse(
                A1111(info=info, width=width, height=height),
                "a1111",
                "A1111 webUI (后处理)",
                extra={"postprocessing": info.get("postprocessing", "")},
            )
        if "negative_prompt" in info or "Negative Prompt" in info:
            return _parse(EasyDiffusion(info=info), "easydiffusion", "Easy Diffusion")
        if "invokeai_metadata" in info or "sd-metadata" in info or "Dream" in info:
            return _parse(InvokeAI(info=info), "invokeai", "InvokeAI")
        if info.get("Software") == "NovelAI" or (
            info.get("Title") == "AI generated image"
            and "Description" in info
            and "Comment" in info
        ):
            return _parse(
                NovelAI(info=info, width=width, height=height), "novelai", "NovelAI"
            )
        if "prompt" in info:
            parser = ComfyUI(info=info, width=width, height=height)
            parser.parse()
            ok = parser.status.name in ("READ_SUCCESS", "COMFYUI_ERROR")
            return parser.to_dict(
                "comfyui",
                "ComfyUI",
                ok=ok,
                extra={
                    "prompt_json": info.get("prompt", ""),
                    "workflow_json": info.get("workflow", ""),
                    "parse_warning": parser.status.name == "COMFYUI_ERROR",
                },
            )
        if "Comment" in info:
            try:
                return _parse(Fooocus(info=json.loads(info["Comment"])), "fooocus", "Fooocus")
            except Exception:
                log.warning("Fooocus 格式解析失败: %s", p.name)
        if "XML:com.adobe.xmp" in info:
            from xml.dom import minidom

            try:
                data = minidom.parseString(info.get("XML:com.adobe.xmp"))
                data_json = json.loads(
                    data.getElementsByTagName("exif:UserComment")[0]
                    .childNodes[1]
                    .childNodes[1]
                    .childNodes[0]
                    .data
                )
                return _parse(DrawThings(info=data_json), "drawthings", "Draw Things")
            except Exception:
                log.warning("Draw Things 格式解析失败: %s", p.name)
        # NovelAI stealth 隐写（最后手段：全像素扫描）
        if stealth and img_rgba is not None:
            hit = try_stealth(img_rgba)
            if hit is not None:
                extractor, compressed = hit
                return _parse(
                    NovelAI(extractor=extractor, width=width, height=height, compressed=compressed),
                    "novelai",
                    "NovelAI (stealth)",
                    extra={"stealth": True},
                )
        return _none_result()

    if fmt in ("JPEG", "JPG", "WEBP"):
        if "comment" in info:
            try:
                return _parse(Fooocus(info=json.loads(info["comment"])), "fooocus", "Fooocus")
            except Exception:
                log.warning("Fooocus JPEG 格式解析失败: %s", p.name)
        if stealth and img_rgba is not None:
            hit = try_stealth(img_rgba)
            if hit is not None:
                extractor, compressed = hit
                return _parse(
                    NovelAI(extractor=extractor, width=width, height=height, compressed=compressed),
                    "novelai",
                    "NovelAI (stealth)",
                    extra={"stealth": True},
                )
        user_comment = ""
        with Image.open(p) as f:
            user_comment = extract_user_comment(f)
        if user_comment:
            if "sui_image_params" in user_comment:
                return _parse(SwarmUI(raw=user_comment), "swarmui", "StableSwarmUI")
            if user_comment.lstrip().startswith("{"):
                return _parse(EasyDiffusion(raw=user_comment), "easydiffusion", "Easy Diffusion")
            return _parse(
                A1111(raw=user_comment, width=width, height=height), "a1111", "A1111 webUI"
            )
    return _none_result()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    result = read_metadata(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False, indent=2))
