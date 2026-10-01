package com.chronoflow.admin.security;

import com.chronoflow.auth.security.AdminActor;

/**
 * 后台管理员上下文。
 */
public record AdminPrincipal(Long adminId, String username, String role, Long orgId) implements AdminActor {
}
