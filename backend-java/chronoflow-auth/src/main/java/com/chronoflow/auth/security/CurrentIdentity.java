package com.chronoflow.auth.security;

import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * 从安全上下文读取当前身份。任何业务代码都通过它获取身份，不信任请求体中的身份字段。
 */
public final class CurrentIdentity {

    private CurrentIdentity() {
    }

    public static IdentityPrincipal require() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof IdentityPrincipal principal) {
            return principal;
        }
        throw BizException.of(ErrorCode.UNAUTHENTICATED);
    }

    public static IdentityPrincipal requireOrgIdentity() {
        IdentityPrincipal principal = require();
        if (!principal.isOrgIdentity()) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该接口需要组织身份");
        }
        return principal;
    }
}
