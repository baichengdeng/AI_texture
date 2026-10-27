# 更新日志

## v0.1 — 首个可用版本

Texture 是一个本地优先的 AI 生成图片管理器：读取图片内嵌的生成元数据，按真实宽高比瀑布流展示，支持搜索、收藏、标签与无限画板。

### 已实现

- **元数据读取**：ComfyUI（prompt + workflow）、A1111 WebUI、NovelAI（含 stealth 隐写）、EasyDiffusion / InvokeAI / Fooocus / SwarmUI / Draw Things
- **图库**：瀑布流与等大网格、缩略图尺寸滑杆、懒加载、来源角标、多选与批量操作、文件夹树
- **搜索过滤**：关键词（NFKC 归一化、逗号即 AND）、来源 / 模型 / 采样器 / 宽高比 / 标签 / 仅收藏
- **信息栏**：参数表、提示词一键复制、原始 JSON、ComfyUI 节点图预览
- **无限画板**：Obsidian Canvas 式节点与连线、视口记忆、自动保存、导出 `.canvas` / 自包含 HTML、导入 `.canvas`
- **导出互转**：A1111 parameters 文本、ComfyUI workflow / prompt JSON
- **桌面外壳**：pywebview + WebView2 原生窗口，`--web` 浏览器模式作为调试回退

### 项目结构

- `app/` 后端（FastAPI 路由、扫描、SQLite 存储、缩略图、导出、ComfyUI 节点图、元数据读取器）
- `web/` 无构建步骤的前端（图库、画板、弹窗）
- `tests/` 测试夹具与断言脚本
- `data/` 本地数据（SQLite、缩略图），已在 `.gitignore` 中排除

### 说明

- 元数据解析器的部分实现参考 [receyuki/stable-diffusion-prompt-reader](https://github.com/receyuki/stable-diffusion-prompt-reader)（MIT License, Copyright 2023 Rhys Yang）
- 本版本同时移除了仓库中的 `pywebview改造手册.md` 与 `需求表.md`（历史提交仍可检索）
