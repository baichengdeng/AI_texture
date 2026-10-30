"""偏好设置 / 隐私模式 / 文件夹导入 的后端验证。

用法：python tests/test_settings_privacy.py
（需要装在装了 fastapi 的解释器里跑，和 run.py 用的是同一个）
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import main as m
from app import settings as st
from app.scanner import Scanner
from app.store import Store

FIX = Path(__file__).parent / "fixtures"
PASSED, FAILED = [], []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print(f"  {'✓' if cond else '✗'} {name}" + (f"  [{detail}]" if detail and not cond else ""))


tmp = Path(tempfile.mkdtemp(prefix="texture-test-"))
try:
    # ---- 隔离：换成临时库，不碰用户数据 ----
    real_store, real_scanner = m.store, m.scanner
    (tmp / "db").mkdir(parents=True, exist_ok=True)
    m.store = Store(tmp / "db" / "texture.db")
    m.scanner = Scanner(m.store)
    m._items_by_id, m._items_list = {}, []

    root = tmp / "library"
    (root / "sub1").mkdir(parents=True)
    (root / "sub2").mkdir(parents=True)
    shutil.copy2(FIX / "a1111.png", root / "sub1" / "one.png")
    shutil.copy2(FIX / "comfyui.png", root / "sub1" / "two.png")
    shutil.copy2(FIX / "plain.png", root / "sub2" / "three.png")

    print("== 偏好设置 ==")
    m.api_add_root(m.RootIn(path=str(root)))
    s = m.api_settings()
    check("默认撤销步数 50", s["undo_limit"] == 50, s["undo_limit"])
    check("已无 folder_mode 偏好键", "folder_mode" not in s, str(list(s)))
    m.api_save_settings(m.SettingsIn(undo_limit=80, image_dir=str(tmp / "store")))
    s = m.api_settings()
    check("撤销步数写入 80", s["undo_limit"] == 80, s["undo_limit"])
    check("内置图片位置生效", Path(s["image_dir"]) == (tmp / "store"), s["image_dir"])
    m.api_save_settings(m.SettingsIn(undo_limit=9999))
    check("撤销步数被夹到上限 500", m.api_settings()["undo_limit"] == 500)
    m.api_save_settings(m.SettingsIn(undo_limit=1))
    check("撤销步数被夹到下限 5", m.api_settings()["undo_limit"] == 5)
    m.api_save_settings(m.SettingsIn(undo_limit=50))

    print("== 搜索语法 ==")
    mm, err = m.parse_search("cat blue")
    check("空格拆成两个词", [x for x in mm] == [("sub", "cat"), ("sub", "blue")], str(mm))
    check("正常查询没有错误", err == "", err)
    mm, err = m.parse_search("cat，blue、dog  cat")
    check("逗号顿号全角都当分隔", len(mm) == 4, str(mm))
    mm, err = m.parse_search("/^paw/ blue")
    check("正则与普通词混用", mm[0][0] == "re" and mm[1] == ("sub", "blue"), str(mm))
    check("混用时无错误", err == "", err)
    mm, err = m.parse_search("/Save Image/ steps")
    check("正则里可以有空格", [x[0] for x in mm] == ["re", "sub"], str(mm))
    check("带空格的正则没被拆坏", mm[0][1].pattern == "Save Image", str(mm))
    mm, err = m.parse_search("/(unclosed/")
    check("坏正则降级成字面量", mm[0][0] == "sub", str(mm))
    check("坏正则回传错误原文", bool(err), err)
    check("词命中", m.search_hit(m.parse_search("cat")[0], "a CAT.png", "a cat.png"))
    check("词不命中", not m.search_hit(m.parse_search("dog")[0], "a cat.png", "a cat.png"))
    check("正则命中", m.search_hit(m.parse_search("/^a c/")[0], "a cat.png", "a cat.png"))
    check("正则不命中", not m.search_hit(m.parse_search("/^c/")[0], "a cat.png", "a cat.png"))

    print("== 隐私模式 ==")
    all_items = m.api_images()["items"]
    check("扫描到 3 张", len(all_items) == 3, str(len(all_items)))
    one = next(x for x in all_items if x["name"] == "one.png")

    m.api_privacy_mark(m.PrivacyMarkIn(fid=one["id"], private=True))
    left = m.api_images()["items"]
    check("图片隐私后列表剩 2 张", len(left) == 2, str(len(left)))
    check("隐私图片不在列表里", all(x["id"] != one["id"] for x in left))
    try:
        m.api_thumb(one["id"])
        check("隐私图片缩略图应 404", False, "居然读到了")
    except m.HTTPException as e:
        check("隐私图片缩略图 404", e.status_code == 404, str(e.status_code))
    check("facets 同步减少", m.api_facets()["total"] == 2)

    m.api_privacy_mode(m.PrivacyModeIn(on=True))
    check("开隐私模式后可见 3 张", len(m.api_images()["items"]) == 3)
    check("开隐私模式后缩略图可读", str(m.api_thumb(one["id"]).path).endswith(".jpg"))

    m.api_privacy_mode(m.PrivacyModeIn(on=False))
    m.api_privacy_mark(m.PrivacyMarkIn(path=str(root / "sub2"), private=True))
    vis = m.api_images()["items"]
    check("文件夹隐私后再少一张（图片隐私仍在）", len(vis) == 1, str(len(vis)))
    tree = m.api_folders()["roots"]
    names = json.dumps(tree, ensure_ascii=False)
    check("侧栏不出现隐私文件夹", "sub2" not in names, names[:80])
    m.api_privacy_mode(m.PrivacyModeIn(on=True))
    check("隐私模式下文件夹回来", "sub2" in json.dumps(m.api_folders()["roots"], ensure_ascii=False))
    m.api_privacy_mode(m.PrivacyModeIn(on=False))

    pay = m.api_privacy()
    check("隐私计数 2 项", pay["count"] == 2, str(pay["count"]))
    for fid in [x["id"] for x in pay["items"]]:
        m.api_privacy_mark(m.PrivacyMarkIn(fid=fid, private=False))
    for d in pay["dirs"]:
        m.api_privacy_mark(m.PrivacyMarkIn(path=d, private=False))
    check("全部取消后恢复 3 张", len(m.api_images()["items"]) == 3)

    print("== 画板隐私遮罩 ==")
    m.api_privacy_mark(m.PrivacyMarkIn(fid=one["id"], private=True))
    bid = m.api_create_board(m.BoardIn(name="板"))["id"]
    img_node = {"id": "img1", "type": "image", "fileId": one["id"],
                "path": str(root / "sub1" / "one.png"),
                "x": 0, "y": 0, "w": 200, "h": 200}
    txt_node = {"id": "txt1", "type": "text", "text": "hello",
                "x": 300, "y": 0, "w": 200, "h": 100}
    m.api_save_board(bid, m.BoardIn(name="板", items=[img_node, txt_node], edges=[]))
    got = m.api_get_board(bid)
    gi = next(x for x in got["items"] if x["id"] == "img1")
    check("图片节点打上 hidden", gi.get("hidden") is True, str(gi))
    check("遮罩后不留 path/src", not gi.get("path") and not gi.get("src"), str(gi))
    check("文本节点不受影响",
          not next(x for x in got["items"] if x["id"] == "txt1").get("hidden"))
    # hidden 只是读取时的状态，不能被前端回存
    m.api_save_board(bid, m.BoardIn(name="板", items=got["items"], edges=[]))
    raw = m.store.board(bid)
    check("hidden 不落库", all("hidden" not in it for it in raw["items"]),
          str(raw["items"]))
    check("遮罩节点回存后 path 仍在库里",
          bool(next(x for x in raw["items"] if x["id"] == "img1").get("path")),
          str(raw["items"]))
    canvas = json.loads(m.api_export_canvas(bid).body)
    check("导出 .canvas 不含被遮罩的图",
          all(n.get("type") != "file" for n in canvas["nodes"]), str(canvas["nodes"]))
    m.api_privacy_mode(m.PrivacyModeIn(on=True))
    gi2 = next(x for x in m.api_get_board(bid)["items"] if x["id"] == "img1")
    check("开隐私后路径回来", not gi2.get("hidden") and bool(gi2.get("path")), str(gi2))
    m.api_privacy_mode(m.PrivacyModeIn(on=False))
    m.api_privacy_mark(m.PrivacyMarkIn(fid=one["id"], private=False))
    m.api_del_board(bid)

    print("== 添加文件夹：复制后清空原文 ==")
    src = tmp / "inbox"
    src.mkdir()
    shutil.copy2(FIX / "a1111.jpg", src / "a.jpg")
    shutil.copy2(FIX / "novelai.png", src / "b.png")
    res = m.api_import_root(m.ImportRootIn(path=str(src)))
    dest = Path(res["dest"])
    check("复制了 2 张", res["copied"] == 2, str(res["copied"]))
    check("目标目录里有文件", len(list(dest.glob("*"))) == 2, str(list(dest.glob("*"))))
    check("原件已移出源目录", not any(src.iterdir()), str(list(src.iterdir())))
    check("导入目录已登记为根目录", str(dest) in m.api_roots()["roots"])

    print("== 添加文件夹：批量 ==")
    b1, b2 = tmp / "batch1", tmp / "batch2"
    b1.mkdir()
    b2.mkdir()
    out = m.api_batch_roots(m.BatchRootIn(
        paths=[str(b1), str(b2), str(b1), str(tmp / "nope")], mode="read"))
    check("批量加了 2 个", len(out["added"]) == 2, str(out["added"]))
    check("倒序重复的路径被去重", len({x["path"] for x in out["added"]}) == 2)
    check("不存在的路径进 skipped", len(out["skipped"]) == 1, str(out["skipped"]))
    check("skipped 带原因", bool(out["skipped"][0]["reason"]), str(out["skipped"]))
    check("两个新目录都登记了",
          str(b1) in m.api_roots()["roots"] and str(b2) in m.api_roots()["roots"])
    try:
        m.api_batch_roots(m.BatchRootIn(paths=[], mode="read"))
        check("空列表应报 400", False, "居然过了")
    except m.HTTPException as e:
        check("空列表报 400", e.status_code == 400, str(e.status_code))
    out = m.api_batch_roots(m.BatchRootIn(paths=[str(b1)], mode="乱写"))
    check("未知 mode 回落 read", out["mode"] == "read", out["mode"])

    print("== 数据目录迁移 ==")
    old_bootstrap = st.BOOTSTRAP
    st.BOOTSTRAP = tmp / "bootstrap.json"
    data_src = tmp / "data-src"
    (data_src / "thumbs").mkdir(parents=True)
    (data_src / "texture.db").write_bytes(b"fake-db")
    (data_src / "thumbs" / "x_512.jpg").write_bytes(b"jpg")
    st.DATA_DIR = data_src
    out = m.api_storage(m.StorageIn(data_dir=str(tmp / "data-dst")))
    check("迁移后需要重启", out["restart"] is True)
    check("数据库已复制", (tmp / "data-dst" / "texture.db").read_bytes() == b"fake-db")
    check("缩略图已复制", (tmp / "data-dst" / "thumbs" / "x_512.jpg").exists())
    check("指针文件写入", st.BOOTSTRAP.is_file())
    check("指针指向新目录", json.loads(st.BOOTSTRAP.read_text(encoding="utf-8"))["data_dir"].endswith("data-dst"))
    st.DATA_DIR = data_src
    st.BOOTSTRAP = old_bootstrap

    m.store, m.scanner = real_store, real_scanner
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"通过 {len(PASSED)} / {len(PASSED) + len(FAILED)}")
if FAILED:
    print("失败项:", FAILED)
    sys.exit(1)
