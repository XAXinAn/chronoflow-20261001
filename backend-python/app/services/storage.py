"""图片存储（spec §5.10）。行为与 Java 版 ImageStorage 对齐。

三条刻意的设计：

1. **格式按文件头判定，不信客户端声明的 MIME**：把 a.exe 改名成 a.jpg 并声明 image/jpeg
   是拦不住的，落盘扩展名由嗅探结果决定；
2. **文件名取内容哈希**：同一张图重复上传天然去重，也不会出现「用户可控的文件名」这种
   路径穿越风险（原始文件名一律不参与落盘路径）；
3. **没配对象存储也能用**：本地目录 + `/uploads/**` 静态映射，接口不绑具体存储。
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from ..errors import ApiError, ErrorCode

DEFAULT_DIR = "./data/uploads"
DEFAULT_MAX_BYTES = 5 * 1024 * 1024

# 扩展名与 MIME 由文件头决定，不看客户端说了什么
_GIF_SIGNATURES = (b"GIF87a", b"GIF89a")


@dataclass(frozen=True)
class StoredImage:
    """url 是相对 URL（如 /uploads/ab12….jpg）：存绝对域名的话，换域名/CDN 就要改数据。"""

    url: str
    size: int
    content_type: str


def sniff(content: bytes) -> tuple[str, str] | None:
    """返回 (扩展名, MIME)；不是受支持的图片则返回 None。"""
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if content.startswith(_GIF_SIGNATURES):
        return "gif", "image/gif"
    # WebP：RIFF????WEBP
    if content.startswith(b"RIFF") and len(content) >= 12 and content[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


class ImageStorage:
    def __init__(self, directory: str | None = None, max_bytes: int | None = None):
        self._root = Path(directory or os.getenv("XATODO_UPLOAD_DIR") or DEFAULT_DIR).resolve()
        self._max_bytes = (
            max_bytes
            if max_bytes is not None
            else int(os.getenv("XATODO_UPLOAD_MAX_BYTES", str(DEFAULT_MAX_BYTES)))
        )

    @property
    def root(self) -> Path:
        return self._root

    def store(self, content: bytes) -> StoredImage:
        if not content:
            raise ApiError(ErrorCode.PARAM_INVALID, "上传内容为空")
        if len(content) > self._max_bytes:
            raise ApiError(
                ErrorCode.UPLOAD_TOO_LARGE,
                f"图片不能超过 {self._max_bytes // 1024 // 1024} MB",
            )
        detected = sniff(content)
        if detected is None:
            raise ApiError(ErrorCode.UPLOAD_TYPE_UNSUPPORTED, "仅支持 JPG / PNG / WebP / GIF 图片")
        extension, content_type = detected

        file_name = f"{hashlib.sha256(content).hexdigest()}.{extension}"
        target = self._root / file_name
        self._root.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            # 内容寻址：同名文件内容必然相同，重复上传直接复用
            target.write_bytes(content)
        return StoredImage(url=f"/uploads/{file_name}", size=len(content), content_type=content_type)
