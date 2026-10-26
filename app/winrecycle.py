"""Windows 回收站删除（ctypes 调 SHFileOperationW，免额外依赖）。"""
import ctypes
from ctypes import wintypes

FO_DELETE = 3
FOF_ALLOWUNDO = 0x40      # 进回收站而不是直接删
FOF_NOCONFIRMATION = 0x10
FOF_SILENT = 0x4
FOF_NOERRORUI = 0x400


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("wFunc", ctypes.c_uint),
        ("pFrom", ctypes.c_wchar_p),
        ("pTo", ctypes.c_wchar_p),
        ("fFlags", ctypes.c_ushort),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", ctypes.c_wchar_p),
    ]


def delete_to_recyclebin(paths: list) -> tuple:
    """把一组文件移入回收站。返回 (成功数, 失败数)。"""
    ok, fail = 0, 0
    for p in paths:  # 逐个删：单个失败不影响其余
        op = SHFILEOPSTRUCTW()
        op.hwnd = None
        op.wFunc = FO_DELETE
        op.pFrom = str(p) + "\0\0"   # pFrom 需双 \0 结尾
        op.pTo = None
        op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
        res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        if res == 0 and not op.fAnyOperationsAborted:
            ok += 1
        else:
            fail += 1
    return ok, fail
