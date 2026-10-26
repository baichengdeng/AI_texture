"""读取器验证：3 个独立读取器各测各的 + 路由统一识别。
用法：python tests/test_readers.py"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.metadata import reader_a1111, reader_comfyui, reader_novelai, router

FIX = Path(__file__).parent / "fixtures"
PASSED = []
FAILED = []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    mark = "✓" if cond else "✗"
    print(f"  {mark} {name}" + (f"  [{detail}]" if detail and not cond else ""))


print("== 读取器 1/3: A1111 ==")
r = reader_a1111.read(FIX / "a1111.png")
check("PNG 识别为 a1111", r["ok"] and r["source"] == "a1111")
check("正面提示词", "masterpiece" in r["prompt"], r["prompt"][:40])
check("负面提示词", "lowres" in r["negative"])
check("参数 steps=28", r["params"]["steps"] == "28", str(r["params"]))
check("参数 sampler=Euler a", r["params"]["sampler"] == "Euler a")
check("参数 model", r["params"]["model"] == "anything-v4.5")
check("尺寸 512x768", r["width"] == "512" and r["height"] == "768", f'{r["width"]}x{r["height"]}')

r = reader_a1111.read(FIX / "a1111.jpg")
check("JPEG EXIF 识别", r["ok"] and r["params"]["steps"] == "28", r["status"])
r = reader_a1111.read(FIX / "a1111.webp")
check("WebP EXIF 识别", r["ok"] and r["params"]["steps"] == "28", r["status"])
r = reader_a1111.read(FIX / "plain.png")
check("非 A1111 图片返回未识别", not r["ok"])

print("== 读取器 2/3: ComfyUI ==")
r = reader_comfyui.read(FIX / "comfyui.png")
check("识别为 comfyui", r["ok"] and r["source"] == "comfyui")
check("正面提示词", "beautiful scenery" in r["prompt"], r["prompt"][:40])
check("负面提示词", r["negative"] == "text, watermark", r["negative"])
check("模型名", r["params"]["model"] == "v1-5-pruned-emaonly.safetensors", r["params"]["model"])
check("steps=20", r["params"]["steps"] == "20")
check("sampler=euler", r["params"]["sampler"] == "euler")
check("seed", r["params"]["seed"] == "156680208700286", r["params"]["seed"])
check("workflow JSON 可导出", '"nodes"' in r["workflow_json"])
r = reader_comfyui.read(FIX / "plain.png")
check("非 ComfyUI 图片返回未识别", not r["ok"])

print("== 读取器 3/3: NovelAI ==")
r = reader_novelai.read(FIX / "novelai.png")
check("标准格式识别", r["ok"] and r["source"] == "novelai")
check("正面提示词", "1girl" in r["prompt"])
check("负面提示词 uc", "lowres" in r["negative"])
check("sampler=k_euler_ancestral", r["params"]["sampler"] == "k_euler_ancestral", str(r["params"]))
check("seed", r["params"]["seed"] == "1234567890")
r = reader_novelai.read(FIX / "novelai_stealth.png")
check("stealth 隐写识别", r["ok"] and r.get("stealth"), r["status"])
check("stealth 提示词", "golden hair" in r["prompt"], r["prompt"][:40])
check("stealth 负面", "watermark" in r["negative"])
check("stealth Source→model", "V4.5" in r["params"]["model"], r["params"]["model"])
check("stealth 尺寸", r["params"]["size"] == "256x256", r["params"]["size"])
r = reader_novelai.read(FIX / "novelai_stealth_plain.png")
check("stealth 未压缩变体识别", r["ok"] and r.get("stealth"), r["status"])
check("未压缩变体提示词", "golden hair" in r["prompt"], r["prompt"][:40])
r = reader_a1111.read(FIX / "a1111_lora.png")
check("A1111 Lora hashes 长尾", r["ok"] and r["params"]["model"] == "animaPencilXL", str(r["params"]))
check("A1111 Lora 采样器", r["params"]["sampler"] == "DPM++ 2M Karras")
r = reader_novelai.read(FIX / "plain.png")
check("非 NAI 图片返回未识别", not r["ok"])

print("== 接口路由 read_metadata ==")
expect = {
    "a1111.png": "a1111",
    "a1111.jpg": "a1111",
    "a1111.webp": "a1111",
    "a1111_lora.png": "a1111",
    "comfyui.png": "comfyui",
    "novelai.png": "novelai",
    "novelai_stealth.png": "novelai",
    "novelai_stealth_plain.png": "novelai",
    "plain.png": "none",
}
for fname, src in expect.items():
    r = router.read_metadata(FIX / fname)
    check(f"{fname} → {src}", r["source"] == src, f'实际 {r["source"]}/{r["status"]}')

print()
print(f"通过 {len(PASSED)} / {len(PASSED) + len(FAILED)}")
if FAILED:
    print("失败项:", FAILED)
    sys.exit(1)
