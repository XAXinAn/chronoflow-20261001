package com.xatodo.admin.security;

import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * 从安全上下文读取当前后台管理员。
 */
public final class CurrentAdmin {

    private CurrentAdmin() {
    }

    public static AdminPrincipal require() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof AdminPrincipal principal) {
            return principal;
        }
        throw BizException.of(ErrorCode.UNAUTHENTICATED);
    }

    public static AdminPrincipal requireSuperAdmin() {
        AdminPrincipal principal = require();
        if (!principal.isSuperAdmin()) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该操作需要平台超管权限");
        }
        return principal;
    }
}
