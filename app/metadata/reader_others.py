"""
附加读取器：EasyDiffusion / InvokeAI / Fooocus / SwarmUI / DrawThings。

全部照搬自 receyuki/stable-diffusion-prompt-reader（MIT）format/ 目录，
仅调整 import 路径。这些格式白送，不保证重点测试。

独立测试：python -m app.metadata.reader_others <图片路径>
"""
import json
import re
import sys
from pathlib import Path
from xml.dom import minidom

from PIL import Image

from ._shared import BaseFormat, remove_quotes


class EasyDiffusion(BaseFormat):
    EASYDIFFUSION_MAPPING_A = {
        "prompt": "Prompt",
        "negative_prompt": "Negative Prompt",
        "seed": "Seed",
        "use_stable_diffusion_model": "Stable Diffusion model",
        "clip_skip": "Clip Skip",
        "use_vae_model": "VAE model",
        "sampler_name": "Sampler",
        "width": "Width",
        "height": "Height",
        "num_inference_steps": "Steps",
        "guidance_scale": "Guidance Scale",
    }
    EASYDIFFUSION_MAPPING_B = {key: key for key, value in EASYDIFFUSION_MAPPING_A.items()}
    SETTING_KEY = ["", "sampler_name", "seed", "guidance_scale", "num_inference_steps", ""]

    def __init__(self, info: dict = None, raw: str = ""):
        super().__init__(info, raw)

    def _process(self):
        if not self._raw:
            self._raw = str(self._info).replace("'", '"')
        self._ed_format()

    def _ed_format(self):
        data_json = json.loads(self._raw)
        ed = (
            EasyDiffusion.EASYDIFFUSION_MAPPING_B
            if data_json.get("prompt")
            else EasyDiffusion.EASYDIFFUSION_MAPPING_A
        )
        self._positive = (data_json.get(ed["prompt"]) or "").strip()
        data_json.pop(ed["prompt"], None)
        self._negative = (data_json.get(ed["negative_prompt"]) or "").strip()
        data_json.pop(ed["negative_prompt"], None)
        file = Path(str(data_json.get(ed["use_stable_diffusion_model"]) or "")).name
        self._setting = (
            remove_quotes(str(data_json)).replace("{", "").replace("}", "")
        ).strip()
        self._width = str(data_json.get(ed["width"]) or "")
        self._height = str(data_json.get(ed["height"]) or "")
        for p, s in zip(BaseFormat.PARAMETER_KEY, EasyDiffusion.SETTING_KEY):
            match p:
                case "model":
                    self._parameter["model"] = str(file)
                case "size":
                    self._parameter["size"] = (
                        str(data_json.get(ed["width"])) + "x" + str(data_json.get(ed["height"]))
                    )
                case _:
                    self._parameter[p] = str(data_json.get(s))


class InvokeAI(BaseFormat):
    SETTING_KEY_INVOKEAI_METADATA = [
        "",
        ("scheduler", "refiner_scheduler"),
        "seed",
        ("cfg_scale", "refiner_cfg_scale"),
        ("steps", "refiner_steps"),
        "",
    ]
    SETTING_KEY_METADATA = ["model_weights", "sampler", "seed", "cfg_scale", "steps", ""]
    SETTING_KEY_DREAM = ["", "A", "S", "C", "s", ""]
    DREAM_MAPPING = {
        "Steps": "s",
        "Seed": "S",
        "Size": "",
        "CFG scale": "C",
        "Sampler": "A",
    }

    def __init__(self, info: dict = None, raw: str = ""):
        super().__init__(info, raw)

    def _process(self):
        if "invokeai_metadata" in self._info:
            self._invoke_metadata()
        elif "sd-metadata" in self._info:
            self._invoke_sd_metadata()
        elif "Dream" in self._info:
            self._invoke_dream()

    def _invoke_metadata(self):
        data_json = json.loads(self._info.get("invokeai_metadata"))
        self._positive = data_json.pop("positive_prompt").strip()
        self._negative = data_json.pop("negative_prompt", "").strip()
        self._raw = "\n".join([self._positive, self._negative, str(data_json)])
        self._setting = remove_quotes(str(data_json)).strip("{ }")
        self._width = str(data_json.get("width") or "")
        self._height = str(data_json.get("height") or "")
        has_refiner = True if data_json.get("refiner_model") else False
        for p, s in zip(BaseFormat.PARAMETER_KEY, InvokeAI.SETTING_KEY_INVOKEAI_METADATA):
            match p:
                case "model":
                    model = (data_json.get("model") or {}).get("model_name", "")
                    if has_refiner:
                        refiner = (data_json.get("refiner_model") or {}).get("model_name", "")
                        self._parameter[p] = remove_quotes(str((model, refiner)))
                    else:
                        self._parameter[p] = str(model)
                case "seed":
                    self._parameter["seed"] = str(data_json.get("seed"))
                case "size":
                    self._parameter["size"] = (
                        str(data_json.get("width")) + "x" + str(data_json.get("height"))
                    )
                case _:
                    if has_refiner:
                        self._parameter[p] = remove_quotes(
                            str((data_json.get(s[0]), data_json.get(s[1])))
                        )
                    else:
                        self._parameter[p] = str(data_json.get(s[0]))

    def _invoke_sd_metadata(self):
        data_json = json.loads(self._info.get("sd-metadata"))
        image = data_json.pop("image")
        prompt = (
            image.get("prompt")[0].get("prompt")
            if isinstance(image.get("prompt"), list)
            else image.get("prompt")
        )
        self._positive, self._negative = self.split_prompt(prompt)
        raw_list = [
            item
            for item in [
                self._positive,
                self._negative,
                self._info.get("Dream"),
                self._info.get("sd-metadata"),
            ]
            if item
        ]
        self._raw = "\n".join(raw_list).strip()
        image.pop("prompt", None)
        self._setting = remove_quotes(
            ", ".join([str(data_json).strip("{ }"), str(image).strip("{ }")])
        )
        self._width = str(image.get("width") or "")
        self._height = str(image.get("height") or "")
        for p, s in zip(BaseFormat.PARAMETER_KEY, InvokeAI.SETTING_KEY_METADATA):
            match p:
                case "model":
                    self._parameter["model"] = data_json.get(s)
                case "size":
                    self._parameter["size"] = (
                        str(image.get("width")) + "x" + str(image.get("height"))
                    )
                case _:
                    self._parameter[p] = str(image.get(s))

    def _invoke_dream(self):
        data = self._info.get("Dream")
        pattern = r'"(.*?)"\s*(.*?)$'
        prompt, setting = re.search(pattern, data).groups()
        self._positive, self._negative = self.split_prompt(prompt.strip('" '))
        self._raw = "\n".join([self._positive, self._negative, self._info.get("Dream")])
        pattern = r"-(\w+)\s+([\w.-]+)"
        setting_dict = dict(re.findall(pattern, setting))
        setting_list = []
        for key, value in InvokeAI.DREAM_MAPPING.items():
            if key == "Size":
                setting_list.append(key + ": " + setting_dict.get("W") + "x" + setting_dict.get("H"))
            else:
                setting_list.append(key + ": " + setting_dict.get(value))
        self._setting = ", ".join(setting_list)
        self._width = str(setting_dict.get("W"))
        self._height = str(setting_dict.get("H"))
        for p, s in zip(BaseFormat.PARAMETER_KEY, InvokeAI.SETTING_KEY_DREAM):
            match p:
                case "model":
                    self._parameter["model"] = ""
                case "size":
                    self._parameter["size"] = (
                        str(setting_dict.get("W")) + "x" + str(setting_dict.get("H"))
                    )
                case _:
                    self._parameter[p] = setting_dict.get(s)

    @staticmethod
    def split_prompt(prompt: str):
        pattern = r"^(.*?)\[(.*?)\]$"
        match = re.match(pattern, prompt)
        if match:
            positive, negative = match.groups()
            positive = positive.strip()
            negative = negative.strip()
        else:
            positive = prompt.strip()
            negative = ""
        return positive, negative


class Fooocus(BaseFormat):
    SETTING_KEY = ["base_model", "sampler", "seed", "cfg", "steps", ""]

    def __init__(self, info: dict = None, raw: str = ""):
        super().__init__(info, raw)

    def _process(self):
        self._fc_format()

    def _fc_format(self):
        data_json = dict(self._info or {})
        self._positive = data_json.get("prompt").strip()
        self._negative = data_json.get("negative_prompt").strip()
        self._raw = "\n".join([self._positive, self._negative, str(data_json)])
        data_json.pop("prompt", None)
        data_json.pop("negative_prompt", None)
        self._setting = remove_quotes(str(data_json)[1:-1]).strip()
        self._width = str(data_json.get("width") or "")
        self._height = str(data_json.get("height") or "")
        for p, s in zip(BaseFormat.PARAMETER_KEY, Fooocus.SETTING_KEY):
            match p:
                case "size":
                    self._parameter["size"] = (
                        str(data_json.get("width")) + "x" + str(data_json.get("height"))
                    )
                case _:
                    self._parameter[p] = str(data_json.get(s))


class SwarmUI(BaseFormat):
    SETTING_KEY = ["model", "", "seed", "cfgscale", "steps", ""]

    def __init__(self, info: dict = None, raw: str = ""):
        super().__init__(info, raw)
        if not self._info:
            self._info = json.loads(self._raw)

    def _process(self):
        self._ss_format()

    def _ss_format(self):
        data_json = self._info.get("sui_image_params")
        self._positive = data_json.get("prompt").strip()
        self._negative = data_json.get("negativeprompt").strip()
        self._raw = "\n".join([self._positive, self._negative, str(data_json)]).strip()
        data_json.pop("prompt", None)
        data_json.pop("negativeprompt", None)
        self._setting = remove_quotes(str(data_json).strip("{ }"))
        self._width = str(data_json.get("width") or "")
        self._height = str(data_json.get("height") or "")
        for p, s in zip(BaseFormat.PARAMETER_KEY, SwarmUI.SETTING_KEY):
            match p:
                case "sampler":
                    comfyuisampler = data_json.get("comfyuisampler")
                    autowebuisampler = data_json.get("autowebuisampler")
                    self._parameter["sampler"] = str(
                        remove_quotes((comfyuisampler, autowebuisampler))
                        if comfyuisampler and autowebuisampler
                        else comfyuisampler or autowebuisampler
                    )
                case "size":
                    self._parameter["size"] = (
                        str(data_json.get("width")) + "x" + str(data_json.get("height"))
                    )
                case _:
                    self._parameter[p] = str(data_json.get(s))


class DrawThings(BaseFormat):
    SETTING_KEY = ["model", "sampler", "seed", "scale", "steps", "size"]

    def __init__(self, info: dict = None, raw: str = ""):
        super().__init__(info, raw)

    def _process(self):
        self._dt_format()

    def _dt_format(self):
        data_json = dict(self._info or {})
        self._positive = data_json.pop("c").strip()
        self._negative = data_json.pop("uc").strip()
        self._raw = "\n".join([self._positive, self._negative, str(data_json)])
        self._setting = remove_quotes(str(data_json).strip("{ }"))
        size = data_json.get("size") or "0x0"
        self._width, self._height = str(size).split("x")[:2] if "x" in str(size) else ("0", "0")
        for p, s in zip(BaseFormat.PARAMETER_KEY, DrawThings.SETTING_KEY):
            self._parameter[p] = str(data_json.get(s))


def read(path) -> dict:
    """读取单张图片，仅尝试附加格式。返回统一元数据 dict。"""
    p = Path(path)
    with Image.open(p) as f:
        info = dict(f.info)
        width, height = f.size
    parser = None
    tool = ""
    source = ""
    if "negative_prompt" in info or "Negative Prompt" in info:
        parser, tool, source = EasyDiffusion(info=info), "Easy Diffusion", "easydiffusion"
    elif "invokeai_metadata" in info or "sd-metadata" in info or "Dream" in info:
        parser, tool, source = InvokeAI(info=info), "InvokeAI", "invokeai"
    elif "Comment" in info:
        try:
            parser, tool, source = Fooocus(info=json.loads(info["Comment"])), "Fooocus", "fooocus"
        except Exception:
            parser = None
    elif "sui_image_params" in str(info.get("parameters", "")):
        parser, tool, source = SwarmUI(raw=info.get("parameters")), "StableSwarmUI", "swarmui"
    elif "XML:com.adobe.xmp" in info:
        try:
            data = minidom.parseString(info.get("XML:com.adobe.xmp"))
            data_json = json.loads(
                data.getElementsByTagName("exif:UserComment")[0]
                .childNodes[1]
                .childNodes[1]
                .childNodes[0]
                .data
            )
            parser, tool, source = DrawThings(info=data_json), "Draw Things", "drawthings"
        except Exception:
            parser = None
    if parser is None:
        return BaseFormat(info).to_dict("others", "", ok=False)
    parser.parse()
    return parser.to_dict(source, tool)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    print(json.dumps(read(sys.argv[1]), ensure_ascii=False, indent=2))
