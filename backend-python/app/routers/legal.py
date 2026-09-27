"""合规文本的公开页面（隐私政策 / 用户协议 / 儿童声明 / 双清单）。

免登录、纯静态、无脚本——应用宝的合规检测要能直接抓这个地址，
App 内的 WebView 打开的也是同一个地址，因此两边内容天然一致。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from ..services.legal import load_document

router = APIRouter(prefix="/api/v1/legal", tags=["legal"])


@router.get("/{doc}")
def document(doc: str) -> Response:
    loaded = load_document(doc)
    if loaded is None:
        # 白名单外的 slug 一律 404：既避免暴露目录结构，也不给路径穿越留口子
        raise HTTPException(status_code=404, detail="合规文档不存在")
    _, html = loaded
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        # 文案随时可能为了合规更新，别让商店的抓取或 WebView 拿到旧版
        headers={"Cache-Control": "no-store"},
    )
