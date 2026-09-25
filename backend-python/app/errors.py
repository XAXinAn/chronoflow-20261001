"""错误码与统一异常处理。

错误码分段与 Java 版完全一致（spec §6.1），否则同一份契约在两版下会表现出不同行为。
"""

from __future__ import annotations

from enum import IntEnum
from contextvars import ContextVar
from typing import Any

_trace_id: ContextVar[str | None] = ContextVar("trace_id", default=None)


def set_trace_id(value: str | None) -> None:
    _trace_id.set(value)


def current_trace_id() -> str | None:
    return _trace_id.get()


def envelope(data: Any = None, code: int = 0, message: str = "ok") -> dict:
    """统一响应体，字段与 Java 版一致：{code, message, data, traceId}。"""
    return {"code": code, "message": message, "data": data, "traceId": current_trace_id()}


class ErrorCode(IntEnum):
    SUCCESS = 0

    PARAM_MISSING = 10001
    PARAM_INVALID = 10002

    UNAUTHENTICATED = 20001
    TOKEN_EXPIRED = 20002
    FORBIDDEN = 20003
    IDENTITY_UNAVAILABLE = 20004
    SMS_SEND_TOO_FREQUENT = 20005
    SMS_CODE_INVALID = 20006
    REFRESH_TOKEN_INVALID = 20007
    ACCOUNT_DISABLED = 20008
    IDENTITY_NOT_OWNED = 20009
    PASSWORD_NOT_SET = 20010
    PASSWORD_MISMATCH = 20011

    EVENT_TIME_INVALID = 30001
    RRULE_INVALID = 30002

    DEPARTMENT_LEVEL_EXCEEDED = 40001
    MEMBER_ALREADY_EXISTS = 40002

    DISPATCH_TARGET_EMPTY = 50001
    DISPATCH_ALREADY_RECEIPTED = 50002

    ADMIN_LOGIN_FAILED = 60001
    MFA_REQUIRED = 60002

    INTERNAL_ERROR = 90001
    THIRD_PARTY_UNAVAILABLE = 90002

    # 上传通道（spec §5.10）：格式与体积都是客户端能直接弄坏的东西，必须有自己的错误码，
    # 否则 App 只能拿到笼统的 90001，给不出任何有用的提示
    UPLOAD_TYPE_UNSUPPORTED = 90003
    UPLOAD_TOO_LARGE = 90004


DEFAULT_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.SUCCESS: "ok",
    ErrorCode.PARAM_MISSING: "参数缺失",
    ErrorCode.PARAM_INVALID: "参数格式错误",
    ErrorCode.UNAUTHENTICATED: "未登录",
    ErrorCode.TOKEN_EXPIRED: "登录已过期",
    ErrorCode.FORBIDDEN: "无权限",
    ErrorCode.IDENTITY_UNAVAILABLE: "身份不可用",
    ErrorCode.SMS_SEND_TOO_FREQUENT: "验证码发送过于频繁",
    ErrorCode.SMS_CODE_INVALID: "验证码错误或已失效",
    ErrorCode.REFRESH_TOKEN_INVALID: "刷新令牌无效或已过期",
    ErrorCode.ACCOUNT_DISABLED: "账号已停用",
    ErrorCode.IDENTITY_NOT_OWNED: "身份不属于当前账号",
    ErrorCode.PASSWORD_NOT_SET: "该账号未设置密码",
    ErrorCode.PASSWORD_MISMATCH: "原密码不正确",
    ErrorCode.INTERNAL_ERROR: "服务内部错误",
    ErrorCode.UPLOAD_TYPE_UNSUPPORTED: "不支持的图片格式",
    ErrorCode.UPLOAD_TOO_LARGE: "图片超出大小上限",
}


class ApiError(Exception):
    """业务异常。由全局处理器转换为统一响应体。"""

    def __init__(self, code: ErrorCode, message: str | None = None, http_status: int = 200):
        super().__init__(message or DEFAULT_MESSAGES.get(code, "请求失败"))
        self.code = code
        self.message = message or DEFAULT_MESSAGES.get(code, "请求失败")
        # 与 Java 版一致：业务可预期错误返回 HTTP 200，语义在 code 里；
        # 认证失败 401、无权限 403、参数错误 400。
        self.http_status = http_status

    @property
    def is_unauthenticated(self) -> bool:
        return self.code in (ErrorCode.UNAUTHENTICATED, ErrorCode.TOKEN_EXPIRED)
