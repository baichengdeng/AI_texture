"""双击入口：无控制台窗口打开 Texture 启动器。

需要 .pyw 已关联到 pythonw.exe（Python 官方安装包默认会关联）。
若双击没反应，改用同目录的「启动 Texture.bat」。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from launcher import main  # noqa: E402

if __name__ == "__main__":
    main()
