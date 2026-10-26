"""节点图模块的断言：python tests/test_comfy_graph.py

覆盖：workflow 排版解析、prompt 参数名合并、仅 API 格式时的自动布局、
节点图转画板（id 唯一、无悬空边、图片节点接在输出节点后）、坏数据兜底。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.comfy_graph import build_graph, graph_to_board, read_graph_for_file  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"
passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name} {extra}")


print("== 从真实图片读取（workflow + prompt）==")
g = read_graph_for_file(FIX / "comfyui.png")
check("识别出节点图", g["ok"])
check("来源是 workflow（有排版）", g["source"] == "workflow")
check("节点数 7", len(g["nodes"]) == 7, len(g["nodes"]))
check("连线数 9", len(g["links"]) == 9, len(g["links"]))
check("分组数 1", len(g["groups"]) == 1, len(g["groups"]))

by_id = {n["id"]: n for n in g["nodes"]}
ks = by_id.get("3", {})
check("KSampler 位置来自 workflow", (ks.get("x"), ks.get("y")) == (900, 180), (ks.get("x"), ks.get("y")))
check("KSampler 尺寸来自 workflow", (ks.get("w"), ks.get("h")) == (315, 262))
texts = {w["v"] for w in ks.get("widgets", [])}
check("参数值解析出来", "20" in texts and "euler" in texts, texts)
names = {w["k"] for w in ks.get("widgets", [])}
check("参数名从 prompt 合并进来", {"steps", "cfg", "sampler_name", "scheduler"} <= names, names)
clip = by_id.get("6", {})
check("长提示词被截断保护", all(len(w["v"]) <= 161 for w in clip.get("widgets", [])))

print("== 仅 API 格式（prompt）==")
from PIL import Image  # noqa: E402

with Image.open(FIX / "comfyui.png") as im:
    info = dict(im.info)
gp = build_graph(None, info["prompt"])
check("回退到 prompt 也能出图", gp["ok"] and gp["source"] == "prompt")
check("节点数一致", len(gp["nodes"]) == 7)
check("连线数一致", len(gp["links"]) == 9)
xs = {n["id"]: n["x"] for n in gp["nodes"]}
check("自动分层：上游在左、采样在右", xs["4"] < xs["3"] < xs["9"], xs)
check("按输入名给出连线类型", {l["type"] for l in gp["links"]} >= {"model", "positive", "negative", "samples"})
check("没有位置信息时也给了尺寸", all(n["w"] > 0 and n["h"] > 0 for n in gp["nodes"]))

print("== 直接给字典（内存里的 workflow）==")
wf = json.loads(info["workflow"])
gd = build_graph(wf)
check("传 dict 也可以", gd["ok"] and gd["source"] == "workflow")

print("== 坏数据兜底 ==")
check("空输入", build_graph(None, None)["ok"] is False)
check("非法 JSON 字符串", build_graph("not json", "{}")["ok"] is False)
check("nodes 不是数组", build_graph({"nodes": "x"}, None)["ok"] is False)
check("空 nodes", build_graph({"nodes": []}, None)["ok"] is False)
odd = build_graph({"nodes": [{"id": 1, "type": "X", "pos": None, "size": "bad",
                             "widgets_values": {"a": 1}}]}, None)
check("坐标/尺寸坏值不崩", odd["ok"] and odd["nodes"][0]["w"] > 0)
check("widgets 是 dict 也能读", odd["nodes"][0]["widgets"] == [{"k": "a", "v": "1"}])
dup = build_graph({"nodes": [{"id": 1}, {"id": 1}], "links": []}, None)
check("重复节点 id 去重", len(dup["nodes"]) == 1)

print("== 节点图 → 画板 ==")
built = graph_to_board(g, fid="abc123", reserved={"c3", "c4"})
check("节点都建出来了", len(built["items"]) == 9, len(built["items"]))   # 7 节点 + 1 分组 + 1 图片
ids = [i["id"] for i in built["items"]]
check("id 唯一", len(ids) == len(set(ids)))
check("避开了已占用的 id", "c3" not in ids and "c4" not in ids)
comfy = [i for i in built["items"] if i["type"] == "comfy"]
check("节点类型是 comfy", len(comfy) == 7)
check("节点带标题与参数", all(i["title"] and "widgets" in i for i in comfy))
check("分组节点存在", any(i["type"] == "group" for i in built["items"]))
alive = set(ids)
check("没有悬空边", all(e["from"]["node"] in alive and e["to"]["node"] in alive for e in built["edges"]))
img = built["imageNode"]
check("图片节点挂在输出节点（SaveImage）后面", img is not None and img["fileId"] == "abc123")
save_id = next(i["id"] for i in comfy if i["cls"] == "SaveImage")
check("有一条 SaveImage → 图片 的边",
      any(e["from"]["node"] == save_id and e["to"]["node"] == img["id"] for e in built["edges"]))
check("坐标已平移到正数", all(i["x"] >= 0 and i["y"] >= 0 for i in built["items"]),
      [(i["id"], i["x"], i["y"]) for i in built["items"] if i["x"] < 0 or i["y"] < 0])
check("两边锚点方向相对", all(e["from"]["side"] != e["to"]["side"] for e in built["edges"]))

no_fid = graph_to_board(g)
check("不给 fid 就不加图片节点", no_fid["imageNode"] is None and len(no_fid["items"]) == 8)
check("空图返回空", graph_to_board({"nodes": []})["items"] == [])

print(f"\n通过 {passed} / {passed + failed}")
sys.exit(1 if failed else 0)
