package com.chronoflow.auth.security;

/**
 * 请求属性键，用于把鉴权失败原因从过滤器传递给 {@code AuthenticationEntryPoint}。
 */
public final class AuthAttributes {

    public static final String AUTH_ERROR_CODE = "chronoflow.auth.errorCode";

    private AuthAttributes() {
    }
}
