# Texture — AI 图片元数据管理

本地优先的 AI 生成图片管理软件：读取并展示图片内嵌的生成元数据（提示词 / 参数 / 工作流），支持浏览、搜索、收藏标签、参数导出互转和无限画布参考墙。

## 外观设定

交付说明只在这里定义一次，改界面时照着它走：

```text
外观：标准（黄 / 中性纸 / 标准切角 / 等高线 / 标准密度 / 完整动效）
主视觉：图库本身——瀑布流格子按真实宽高比排布，编号与张数是真实数据
页面类型：图库与信息栏为控制台，画板为工作区
主题：浅色默认，深色是完整的第二套
```

固定规则（不随产品改）：只有一个强调色，只表示"当前 / 可点 / 要注意"，只做填充；红色只给删除；切掉一个角＝可以按，不可点的容器是直角，圆角一律 0；宽体大写英文配粗体中文；编号日期计数都是真实字段；细线分区，不堆卡片，无投影与装饰性渐变；动效短、硬、机械，系统要求减少动态效果时全部关闭。

字体：界面为 Saira（宽体几何）+ 中文黑体，正文为中文黑体常规字重，数字用等宽数字。项目不打包字体文件，系统缺失 Saira 时自动退回中文黑体，布局不受影响；要完全一致，把 Saira 的 woff2 放进 `web/fonts/` 并在 `web/style.css` 末尾加 `@font-face`。

## 支持的元数据格式

| 来源 | 载体 | 备注 |
|---|---|---|
| **ComfyUI** | PNG tEXt/zTXt：`prompt` + `workflow` | 从节点图提取正/负提示词与采样参数；workflow JSON 可下载拖回画布 |
| **A1111 WebUI** | PNG `parameters`；JPEG/WebP EXIF | 含 Lora hashes 等长尾字段 |
| **NovelAI** | PNG `Title`/`Description`/`Software`/`Source`/`Comment` | V4 系 char_prompts 保留在原始数据 |
| **NovelAI Stealth** | PNG alpha 通道 LSB 隐写 | 压缩 (`stealth_pngcomp`) 与未压缩 (`stealth_pnginfo`) 双变体 |
| 附加 | EasyDiffusion / InvokeAI / Fooocus / SwarmUI / Draw Things | 照搬 SD Prompt Reader 的现成实现 |

> 解析器代码照搬自 [receyuki/stable-diffusion-prompt-reader](https://github.com/receyuki/stable-diffusion-prompt-reader)（**MIT License, Copyright 2023 Rhys Yang**），保留版权声明，特此致谢。

## 快速开始

```bash
pip install -r requirements.txt   # fastapi uvicorn pillow numpy piexif pywebview
python run.py                     # 原生桌面窗口（pywebview / WebView2，无地址栏）
python run.py --web               # 浏览器模式（调试回退，自动开浏览器）
python run.py --debug             # 原生窗口 + WebView2 开发者工具
python run.py --port 9000         # 换端口（前后端同一端口）
```

**端口策略**（统一由 run.py 管理，默认 8770）：启动前自动检测端口占用——是 Texture 旧实例或残留 python 进程会**自动关闭并接管**（控制台打印 `[端口] 已自动关闭旧进程…`）；被其他程序占用则明确提示并退出，不会误杀。重复启动 `python run.py` 永远只会保留最新一个实例。

启动后点右上角「＋ 文件夹」（原生窗口弹系统文件夹选择器）添加图片目录即可。数据（SQLite、缩略图）都在 `data/` 下，删除即重置。关闭窗口即退出，端口自动释放。

## 功能

**界面（控制台式骨架）**：深色命令栏（品牌 + 视图切换 + 搜索 + 设置）＋ 竖排导航侧栏（全部图片 / 收藏 / 无元数据，带真实计数；文件夹树、筛选、标签）＋ 右侧常驻信息栏（`I` 收起 / 展开，可固定）。浅色为默认，设置里切深色。

- **网格图库**：瀑布流 / 等大网格两种布局（`▤/▦` 切换）、缩略图尺寸滑杆、懒加载缩略图、来源角标、收藏星标、标签
- **多选与批量**：Ctrl/Shift 点选、Ctrl+A 全选、底部批量条（收藏 / 加标签 / 移入回收站）
- **文件夹树**：按根目录递归聚合、显示含子目录总数、折叠状态记忆、可直接从树里移除根目录
- **元数据面板**：参数表 / 提示词（一键复制）/ 原始 JSON；灯箱内 ←→ 翻页，滚轮缩放、双击 2×、拖拽平移
- **搜索过滤**：关键词（提示词+文件名，NFKC 归一化、逗号＝AND）、来源/模型/采样器/宽高比/标签/仅收藏
- **收藏与标签**：SQLite 持久化；文件指纹 = 大小+前64KB 内容哈希，改名/移动不丢
- **导出互转**：A1111 parameters 文本（NovelAI 采样器自动映射）、ComfyUI workflow/prompt JSON
- **原生桌面窗口**：pywebview/WebView2；浏览器原生弹窗已替换为双模式模态框，`--web` 回退保留

### 无限画板（Obsidian Canvas 式）

- **节点类型**：图片 / 文本 / 链接 / 分组；节点 `id` 与图片指纹 `fileId` 分离，**同一张图可重复放上画板**
- **文本节点**：默认 240×160，尺寸只由拖右下角决定，**不会随输入自动变高**；内容超出时在框内滚动。双击空白新建，双击节点进入编辑，`Esc` 结束
- **交互**：框选、Shift/Ctrl 加选、成组拖动、八向…四向锚点拖出连线、四角缩放（Alt 自由比例）、双击空白新建文本
- **连线**：贝塞尔曲线、可编辑标签、箭头（末端/双向）、6 色
- **视图**：滚轮以指针为中心缩放、空格/中键/Alt 拖动平移、适应全部（`F`）、100%（`0`）、**每个画板的视口记忆**
- **编辑**：Ctrl+C/V/D、Delete、方向键微调（Shift ×10）、层级 `[` `]`、右键菜单、6 色标记（节点与连线共用 Obsidian 色板）
- **素材抽屉**：底部横向条，可直接拖图上板；图库右键「加入当前画板」批量放入（自动建板）
- **保存**：改动后 0.9s 防抖自动保存；revision 机制保证「保存期间的新改动不会被误标已保存」；切换画板/离开视图/关窗前强制落盘（`keepalive`）
- **导入导出**：导出**自包含 HTML**（内嵌缩略图，`?full=1` 内嵌原图，带平移缩放）／导出 **Obsidian `.canvas`**（可指定库根目录写相对路径）／**导入 `.canvas`**（绝对路径、库内相对路径、全库唯一文件名三级匹配；匹配不到的图片保留虚线占位，悬空边自动丢弃）

## 快捷键

| 键 | 作用 |
|---|---|
| `←` `→` / `Enter` | 图库切换选中 / 放大查看 |
| Ctrl / Shift + 点击、Ctrl+A | 多选 / 范围选择 / 全选 |
| `I` `N` `?` | 信息栏 · 左侧栏 · 快捷键面板 |
| `F` `0` `+` `−` | 画板：适应全部 / 100% / 缩放 |
| 空格拖 · 中键拖 | 画板：平移 |
| Delete · Ctrl+D · Ctrl+C/V | 画板：删除 / 复制 / 复制粘贴节点 |
| 方向键、`[` `]` | 画板：微调（Shift ×10）、层级 |

## 项目结构

```
run.py                 启动入口（127.0.0.1，纯本地）
app/
  main.py              FastAPI 路由（摘要/详情分离、文件夹树、.canvas 导入导出）
  scanner.py           扫描（stealth 快路径、批量事务缓存、孤儿回收）
  store.py             SQLite：根目录/收藏/标签/画板/元数据缓存（含 v1 画板节点兼容归一化）
  thumbnails.py        缩略图缓存（透明底合成白底）
  export.py            A1111 文本 / workflow JSON / Obsidian .canvas / 画板自包含 HTML
  metadata/            ← 3 个独立读取器 + 接口路由（可单独运行）
    reader_a1111.py      python -m app.metadata.reader_a1111 <图片>
    reader_comfyui.py    python -m app.metadata.reader_comfyui <图片>
    reader_novelai.py    python -m app.metadata.reader_novelai <图片>
    reader_others.py     其余 5 种格式
    router.py            主入口 read_metadata(path, stealth=)
web/                   无构建步骤的原生前端
  index.html           三段式骨架（顶栏 / 侧栏 / 视图 + 信息栏）
  style.css            中性灰设计系统（深浅两套变量）
  app.js               图库：文件夹树 / 过滤 / 瀑布流 / 灯箱 / 多选 / 信息栏
  board.js             画板：无限画布 / 连线 / 多选 / 视口记忆 / 自动保存 / .canvas
  dialogs.js           双模式弹窗与文件夹选择（原生桥 / 浏览器回退）
tests/
  make_fixtures.py     生成 9 张各格式测试图
  test_readers.py      43 项断言（python tests/test_readers.py）
```

## 性能

- 冷扫描 207 张（含 66 张 stealth RGBA）0.11s；二次扫描全缓存命中 <0.05s
- 扫库快路径只读 PNG 文本块（不整图解码）；stealth 全像素检测只在打开详情时按需执行
- 元数据缓存只存轻量摘要（最大行 ~650B），workflow 等大 JSON 详情页从文件重读

## 已知限制 / 下一步

- 测试夹具均为程序生成，**真实世界语料**（真实 A1111/ComfyUI/NovelAI V4.5 图）待收集验证
- A1111 负面提示词内含换行 `Steps:` 的极端样例可能解析偏差
- Windows 长路径(>260)与网络盘/OneDrive 目录未做特殊处理
- 图库仍未做真·DOM 虚拟化：几千张以内靠 `content-visibility` + 懒加载够用，上万张建议再加窗口化
- `.canvas` 的 group 节点只做平铺显示（不含 Obsidian 的「节点归属分组」语义）；导入时保留 label 与位置
- 画板视口存在浏览器 `localStorage`（`texture.view.<boardId>`），换机器/清缓存后回到「适应全部」
