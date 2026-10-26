"""生成 7 张测试图片：三大平台格式 + EXIF 变体 + stealth 隐写 + 无元数据。
用法：python tests/make_fixtures.py [输出目录（默认 tests/fixtures）]"""
import json
import sys
from pathlib import Path

import piexif
import piexif.helper
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.metadata.reader_novelai import embed_stealth

A1111_TEXT = (
    "masterpiece, best quality, 1girl, silver hair\n"
    "Negative prompt: lowres, bad anatomy, bad hands\n"
    "Steps: 28, Sampler: Euler a, CFG scale: 7, Seed: 321654987, Size: 512x768, "
    "Model hash: e6e9eab2b2, Model: anything-v4.5"
)

A1111_LORA_TEXT = (
    "((masterpiece)), best quality, <lora:detail:0.8>\n"
    "Negative prompt: lowres, text\n"
    "Steps: 24, Sampler: DPM++ 2M Karras, CFG scale: 6.5, Seed: 42, "
    "Size: 832x1216, Model hash: abc123, Model: animaPencilXL, "
    'Lora hashes: "detail_tweaker_xl: 9e buz, add_detail: 1a2b3c", '
    "Version: v1.10.0"
)

COMFY_PROMPT = {
    "3": {"class_type": "KSampler", "inputs": {
        "seed": 156680208700286, "steps": 20, "cfg": 8.0,
        "sampler_name": "euler", "scheduler": "normal", "denoise": 1,
        "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
        "latent_image": ["5", 0]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {
        "ckpt_name": "v1-5-pruned-emaonly.safetensors"}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {
        "width": 512, "height": 512, "batch_size": 1}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {
        "text": "beautiful scenery nature glass bottle landscape, purple galaxy bottle",
        "clip": ["4", 1]}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {
        "text": "text, watermark", "clip": ["4", 1]}},
    "8": {"class_type": "VAEDecode", "inputs": {
        "samples": ["3", 0], "vae": ["4", 2]}},
    "9": {"class_type": "SaveImage", "inputs": {
        "filename_prefix": "ComfyUI", "images": ["8", 0]}},
}
# UI 格式的 workflow：带位置、尺寸、连线与分组，用于节点图渲染
COMFY_WORKFLOW = {
    "last_node_id": 9,
    "last_link_id": 9,
    "nodes": [
        {"id": 4, "type": "CheckpointLoaderSimple", "pos": [40, 180], "size": [315, 98],
         "flags": {}, "order": 0, "mode": 0,
         "outputs": [{"name": "MODEL", "type": "MODEL", "links": [1]},
                     {"name": "CLIP", "type": "CLIP", "links": [5, 6]},
                     {"name": "VAE", "type": "VAE", "links": [8]}],
         "widgets_values": ["v1-5-pruned-emaonly.safetensors"]},
        {"id": 6, "type": "CLIPTextEncode", "pos": [420, 40], "size": [400, 160],
         "flags": {}, "order": 1, "mode": 0,
         "inputs": [{"name": "clip", "type": "CLIP", "link": 5}],
         "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [2]}],
         "widgets_values": ["beautiful scenery nature glass bottle landscape, purple galaxy bottle"]},
        {"id": 7, "type": "CLIPTextEncode", "pos": [420, 240], "size": [400, 110],
         "flags": {}, "order": 2, "mode": 0,
         "inputs": [{"name": "clip", "type": "CLIP", "link": 6}],
         "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [3]}],
         "widgets_values": ["text, watermark"]},
        {"id": 5, "type": "EmptyLatentImage", "pos": [420, 400], "size": [315, 106],
         "flags": {}, "order": 3, "mode": 0,
         "outputs": [{"name": "LATENT", "type": "LATENT", "links": [4]}],
         "widgets_values": [512, 512, 1]},
        {"id": 3, "type": "KSampler", "pos": [900, 180], "size": [315, 262],
         "flags": {}, "order": 4, "mode": 0,
         "inputs": [{"name": "model", "type": "MODEL", "link": 1},
                    {"name": "positive", "type": "CONDITIONING", "link": 2},
                    {"name": "negative", "type": "CONDITIONING", "link": 3},
                    {"name": "latent_image", "type": "LATENT", "link": 4}],
         "outputs": [{"name": "LATENT", "type": "LATENT", "links": [7]}],
         "widgets_values": [156680208700286, "randomize", 20, 8.0, "euler", "normal", 1]},
        {"id": 8, "type": "VAEDecode", "pos": [1280, 180], "size": [210, 46],
         "flags": {}, "order": 5, "mode": 0,
         "inputs": [{"name": "samples", "type": "LATENT", "link": 7},
                    {"name": "vae", "type": "VAE", "link": 8}],
         "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [9]}]},
        {"id": 9, "type": "SaveImage", "pos": [1540, 180], "size": [315, 270],
         "flags": {}, "order": 6, "mode": 0,
         "inputs": [{"name": "images", "type": "IMAGE", "link": 9}],
         "widgets_values": ["ComfyUI"]},
    ],
    "links": [
        [1, 4, 0, 3, 0, "MODEL"],
        [2, 6, 0, 3, 1, "CONDITIONING"],
        [3, 7, 0, 3, 2, "CONDITIONING"],
        [4, 5, 0, 3, 3, "LATENT"],
        [5, 4, 1, 6, 0, "CLIP"],
        [6, 4, 1, 7, 0, "CLIP"],
        [7, 3, 0, 8, 0, "LATENT"],
        [8, 4, 2, 8, 1, "VAE"],
        [9, 8, 0, 9, 0, "IMAGE"],
    ],
    "groups": [{"title": "采样", "bounding": [880, 120, 360, 400], "color": "#3f789e"}],
    "config": {}, "extra": {}, "version": 0.4,
}

NAI_COMMENT = {
    "prompt": "1girl, silver hair, beautiful detailed eyes, kimono",
    "steps": 28, "sampler": "k_euler_ancestral", "seed": 1234567890,
    "scale": 5.0, "uc": "lowres, bad anatomy, watermark",
    "noise_schedule": "karras", "uc_scale": 5.0,
}

STEALTH_PAYLOAD = {
    "Title": "AI generated image",
    "Description": "1girl, golden hair, shrine, sunset",
    "Software": "NovelAI",
    "Source": "NovelAI Diffusion V4.5 4BDE34A5",
    "Comment": json.dumps({
        "prompt": "1girl, golden hair, shrine, sunset",
        "uc": "lowres, watermark",
        "steps": 23, "sampler": "k_euler", "seed": 42,
        "scale": 6.0, "noise_schedule": "karras",
        "width": 256, "height": 256,
    }),
    "width": 256, "height": 256,
}


def make(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    base = Image.new("RGB", (128, 128), (120, 130, 200))

    # 1. A1111 PNG
    png = __import__("PIL.PngImagePlugin", fromlist=["PngInfo"]).PngInfo()
    png.add_text("parameters", A1111_TEXT)
    base.save(out / "a1111.png", pnginfo=png)

    # 2. A1111 JPEG（EXIF UserComment）
    exif = piexif.dump({"Exif": {
        piexif.ExifIFD.UserComment: piexif.helper.UserComment.dump(A1111_TEXT, encoding="unicode")
    }})
    base.convert("RGB").save(out / "a1111.jpg", quality=90, exif=exif)

    # 3. A1111 WebP（EXIF UserComment）
    base.save(out / "a1111.webp", exif=exif)

    # 4. ComfyUI PNG
    png = __import__("PIL.PngImagePlugin", fromlist=["PngInfo"]).PngInfo()
    png.add_text("prompt", json.dumps(COMFY_PROMPT))
    png.add_text("workflow", json.dumps(COMFY_WORKFLOW))
    base.save(out / "comfyui.png", pnginfo=png)

    # 5. NovelAI PNG（标准 tEXt）
    png = __import__("PIL.PngImagePlugin", fromlist=["PngInfo"]).PngInfo()
    png.add_text("Title", "AI generated image")
    png.add_text("Description", NAI_COMMENT["prompt"])
    png.add_text("Software", "NovelAI")
    png.add_text("Source", "Stable Diffusion XL 1.0")
    png.add_text("Comment", json.dumps(NAI_COMMENT))
    base.save(out / "novelai.png", pnginfo=png)

    # 6. NovelAI stealth（alpha LSB 压缩变体，无任何文本块）
    img = Image.new("RGBA", (256, 256), (100, 150, 200, 255))
    embed_stealth(img, STEALTH_PAYLOAD).save(out / "novelai_stealth.png")

    # 6b. NovelAI stealth 未压缩变体（stealth_pnginfo）
    embed_stealth(img, STEALTH_PAYLOAD, compressed=False).save(out / "novelai_stealth_plain.png")

    # 1b. A1111 带 Lora hashes / Version 长尾字段
    png = __import__("PIL.PngImagePlugin", fromlist=["PngInfo"]).PngInfo()
    png.add_text("parameters", A1111_LORA_TEXT)
    base.save(out / "a1111_lora.png", pnginfo=png)

    # 7. 无元数据
    base.save(out / "plain.png")

    print(f"已生成 {len(list(out.glob('*')))} 个夹具 → {out}")


if __name__ == "__main__":
    make(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "fixtures")
