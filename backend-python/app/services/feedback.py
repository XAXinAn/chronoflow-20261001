"""意见反馈（spec §4.1.9）。行为与 Java 版 FeedbackService 对齐。

用户侧只提交与查看自己的（按账号过滤）；后台侧由超管查阅与处理。
"""

from __future__ import annotations

import json

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode

CATEGORIES = {"BUG", "SUGGESTION", "OTHER"}
STATUSES = {"OPEN", "HANDLED"}
MAX_IMAGES = 9
MAX_CONTENT_LENGTH = 2000
DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def _view(row) -> dict:
    images = row["images"]
    if isinstance(images, str):  # 驱动返回字符串时也要能读
        images = json.loads(images)
    return {
        "id": row["id"],
        "category": row["category"],
        "content": row["content"],
        "images": images or [],
        "status": row["status"],
        "createdAt": row["created_at"],
        "handledAt": row["handled_at"],
    }


def _limit(value: int | None) -> int:
    if value is None:
        return DEFAULT_LIMIT
    return max(1, min(int(value), MAX_LIMIT))


class FeedbackService:
    def __init__(self, session: Session):
        self._session = session

    def create(self, account_id: int, identity_id: int, payload: dict) -> dict:
        content = str(payload.get("content") or "").strip()
        if not content:
            raise ApiError(ErrorCode.PARAM_MISSING, "反馈内容不能为空")
        if len(content) > MAX_CONTENT_LENGTH:
            raise ApiError(ErrorCode.PARAM_INVALID, f"反馈内容最长 {MAX_CONTENT_LENGTH} 个字符")

        category = str(payload.get("category") or "OTHER").strip().upper()
        if category not in CATEGORIES:
            raise ApiError(ErrorCode.PARAM_INVALID, f"反馈分类取值非法: {payload.get('category')}")

        images = self._validate_images(payload.get("images"))

        # RETURNING *：created_at 由数据库生成，回内存对象会出现「响应里没有创建时间」这种假成功
        row = (
            self._session.execute(
                text(
                    "INSERT INTO feedback (account_id, identity_id, category, content, images, status)"
                    " VALUES (:account, :identity, :category, :content, CAST(:images AS jsonb), 'OPEN')"
                    " RETURNING *"
                ),
                {
                    "account": account_id,
                    "identity": identity_id,
                    "category": category,
                    "content": content,
                    # jsonb 列不能用数组适配器直接塞：显式序列化再 CAST
                    "images": json.dumps(images, ensure_ascii=False),
                },
            )
            .mappings()
            .one()
        )
        # Python 没有 @Transactional 的等价物，写操作必须显式 commit（否则接口成功、数据不在）
        self._session.commit()
        return _view(row)

    def list_mine(self, account_id: int, limit: int | None = None) -> list[dict]:
        rows = (
            self._session.execute(
                text(
                    "SELECT * FROM feedback WHERE account_id = :account"
                    " ORDER BY created_at DESC LIMIT :limit"
                ),
                {"account": account_id, "limit": _limit(limit)},
            )
            .mappings()
            .all()
        )
        return [_view(row) for row in rows]

    def list_for_admin(
        self, status: str | None = None, category: str | None = None, limit: int | None = None
    ) -> list[dict]:
        effective_status = (status or "OPEN").strip().upper()
        if effective_status not in STATUSES:
            raise ApiError(ErrorCode.PARAM_INVALID, f"status 取值非法: {status}")

        effective_category = (category or "").strip().upper()
        if effective_category and effective_category not in CATEGORIES:
            raise ApiError(ErrorCode.PARAM_INVALID, f"category 取值非法: {category}")

        rows = (
            self._session.execute(
                text(
                    "SELECT * FROM feedback"
                    " WHERE status = :status"
                    # 显式 CAST：不写类型时 PG 无法推断 NULL 参数的类型（AmbiguousParameter）
                    " AND (CAST(:category AS text) IS NULL OR category = CAST(:category AS text))"
                    " ORDER BY created_at DESC LIMIT :limit"
                ),
                {
                    "status": effective_status,
                    "category": effective_category or None,
                    "limit": _limit(limit),
                },
            )
            .mappings()
            .all()
        )
        return [_view(row) for row in rows]

    def handle(self, admin_id: int, feedback_id: int) -> dict:
        row = (
            self._session.execute(
                text(
                    "UPDATE feedback SET status = 'HANDLED', handled_at = now(),"
                    " handled_by_admin_id = :admin"
                    " WHERE id = :id AND status = 'OPEN' RETURNING *"
                ),
                {"admin": admin_id, "id": feedback_id},
            )
            .mappings()
            .first()
        )
        if row is None:
            existing = (
                self._session.execute(
                    text("SELECT * FROM feedback WHERE id = :id"), {"id": feedback_id}
                )
                .mappings()
                .first()
            )
            if existing is None:
                raise ApiError(ErrorCode.PARAM_INVALID, "反馈不存在")
            # 幂等：重复点「标记已处理」不该报错，也不该覆盖原处理人
            return _view(existing)

        self._session.commit()
        return _view(row)

    @staticmethod
    def _validate_images(images) -> list[str]:
        """图片只接受本服务上传通道产生的相对 URL。

        不校验的话，客户端可以把任意外链塞进 images——那等于让别人的服务在我们的用户界面上
        打广告或埋追踪，后台也会跟着去取。
        """
        if not images:
            return []
        if len(images) > MAX_IMAGES:
            raise ApiError(ErrorCode.PARAM_INVALID, f"最多上传 {MAX_IMAGES} 张图片")
        for image in images:
            if not isinstance(image, str) or not image.startswith("/uploads/") or ".." in image:
                raise ApiError(ErrorCode.PARAM_INVALID, f"图片地址非法: {image}")
        return list(images)
