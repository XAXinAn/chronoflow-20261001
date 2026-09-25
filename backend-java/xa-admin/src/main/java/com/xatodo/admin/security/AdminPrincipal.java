package com.xatodo.admin.security;

/**
 * 后台管理员上下文。
 */
public record AdminPrincipal(Long adminId, String username, String role, Long orgId) {

    public boolean isSuperAdmin() {
        return "SUPER_ADMIN".equals(role);
    }
}
