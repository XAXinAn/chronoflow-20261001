package com.xatodo.common.api;

/**
 * 全局错误码，分段规则见 spec §6.1。
 */
public enum ErrorCode {

    SUCCESS(0, "ok"),

    // 1xxxx 通用 / 参数校验
    PARAM_MISSING(10001, "参数缺失"),
    PARAM_INVALID(10002, "参数格式错误"),

    // 2xxxx 认证与鉴权
    UNAUTHENTICATED(20001, "未登录"),
    TOKEN_EXPIRED(20002, "登录已过期"),
    FORBIDDEN(20003, "无权限"),
    IDENTITY_UNAVAILABLE(20004, "身份不可用"),
    SMS_SEND_TOO_FREQUENT(20005, "验证码发送过于频繁"),
    SMS_CODE_INVALID(20006, "验证码错误或已失效"),
    REFRESH_TOKEN_INVALID(20007, "刷新令牌无效或已过期"),
    ACCOUNT_DISABLED(20008, "账号已停用"),
    IDENTITY_NOT_OWNED(20009, "身份不属于当前账号"),
    PASSWORD_NOT_SET(20010, "该账号未设置密码"),
    PASSWORD_MISMATCH(20011, "原密码不正确"),

    // 3xxxx 个人日历 / 日程 / 待办
    EVENT_TIME_INVALID(30001, "日程时间非法"),
    RRULE_INVALID(30002, "重复规则非法"),

    // 4xxxx 组织 / 部门 / 成员
    DEPARTMENT_LEVEL_EXCEEDED(40001, "部门层级超限"),
    MEMBER_ALREADY_EXISTS(40002, "成员已存在"),

    // 5xxxx 组织日历与下发
    DISPATCH_TARGET_EMPTY(50001, "下发目标为空"),
    DISPATCH_ALREADY_RECEIPTED(50002, "已回执不可撤回"),

    // 6xxxx 后台管理
    ADMIN_LOGIN_FAILED(60001, "管理员登录失败"),
    MFA_REQUIRED(60002, "需要双因素校验"),

    // 9xxxx 系统
    INTERNAL_ERROR(90001, "服务内部错误"),
    THIRD_PARTY_UNAVAILABLE(90002, "第三方服务不可用"),

    // 上传通道（spec §5.10）：格式与体积都是客户端能直接弄坏的东西，必须有自己的错误码，
    // 否则 App 只能拿到笼统的 90001，给不出任何有用的提示
    UPLOAD_TYPE_UNSUPPORTED(90003, "不支持的图片格式"),
    UPLOAD_TOO_LARGE(90004, "图片超出大小上限");

    private final int code;
    private final String message;

    ErrorCode(int code, String message) {
        this.code = code;
        this.message = message;
    }

    public int getCode() {
        return code;
    }

    public String getMessage() {
        return message;
    }
}
