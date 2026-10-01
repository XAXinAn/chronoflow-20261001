package com.chronoflow.auth.security;

/**
 * 当前请求的身份上下文，由访问令牌解析得到（spec §6.1「身份上下文」）。
 */
public record IdentityPrincipal(Long accountId, Long identityId, String identityType, Long orgId) {

    public boolean isOrgIdentity() {
        return orgId != null;
    }
}
