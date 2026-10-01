package com.chronoflow.auth.security;

/**
 * 令牌用途。只有 {@link #ACCESS} 可用于访问业务接口。
 */
public enum TokenScope {
    /** 已选定身份的访问令牌 */
    ACCESS,
    /** 首次登录后用于创建个人身份的临时令牌 */
    REGISTER,
    /** 登录成功后用于选择身份的临时令牌 */
    IDENTITY_SELECT,
    /** 后台管理员令牌（独立于 C 端身份体系） */
    ADMIN
}
