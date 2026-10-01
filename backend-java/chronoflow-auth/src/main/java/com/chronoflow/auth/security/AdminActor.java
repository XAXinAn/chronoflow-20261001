package com.chronoflow.auth.security;

/**
 * 后台管理员上下文的最小契约（spec §3.2）。
 *
 * <p>刻意定义在 {@code chronoflow-auth} 而不是 {@code chronoflow-admin}：组织管理端接口
 * （{@code /org-admin/**}）也要按「后台组织管理员」判定权限，而 {@code chronoflow-org}
 * 不依赖 {@code chronoflow-admin}（反向依赖）。真正实现该接口的是
 * {@code com.chronoflow.admin.security.AdminPrincipal}。
 */
public interface AdminActor {

    String ROLE_SUPER_ADMIN = "SUPER_ADMIN";
    String ROLE_ORG_ADMIN = "ORG_ADMIN";

    Long adminId();

    String username();

    String role();

    /** 平台超管为空；组织管理员为所属组织。 */
    Long orgId();

    default boolean isSuperAdmin() {
        return ROLE_SUPER_ADMIN.equals(role());
    }
}
