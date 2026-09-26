package com.xatodo.admin.security;

import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 后台接口的令牌解析：平台超管端（{@code /api/v1/admin/**}）与组织管理端（{@code /api/v1/org-admin/**}）。
 *
 * <p>{@code /org-admin/**} 同时接受组织身份的 `ACCESS` 令牌（App 侧的组织管理员，spec §3.2），
 * 因此这里只是**尝试**解析后台令牌；解析失败不设置认证，交给 Jwt 过滤器按 C 端令牌再试一次。
 */
@Component
public class AdminAuthenticationFilter extends OncePerRequestFilter {

    private static final String BEARER_PREFIX = "Bearer ";
    private static final String ADMIN_PATH_PREFIX = "/api/v1/admin/";
    private static final String ORG_CONSOLE_PATH_PREFIX = "/api/v1/org-admin/";

    private final AdminTokenService adminTokenService;

    public AdminAuthenticationFilter(AdminTokenService adminTokenService) {
        this.adminTokenService = adminTokenService;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String uri = request.getRequestURI();
        return !uri.startsWith(ADMIN_PATH_PREFIX) && !uri.startsWith(ORG_CONSOLE_PATH_PREFIX);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (StringUtils.hasText(header) && header.startsWith(BEARER_PREFIX)) {
            try {
                AdminPrincipal principal = adminTokenService.parse(header.substring(BEARER_PREFIX.length()).trim());
                UsernamePasswordAuthenticationToken authentication =
                        new UsernamePasswordAuthenticationToken(
                                principal, null,
                                List.of(new SimpleGrantedAuthority("ROLE_" + principal.role())));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            } catch (BizException ex) {
                request.setAttribute(com.xatodo.auth.security.AuthAttributes.AUTH_ERROR_CODE,
                        ex.getErrorCode() == null ? ErrorCode.UNAUTHENTICATED : ex.getErrorCode());
            }
        }
        filterChain.doFilter(request, response);
    }
}
