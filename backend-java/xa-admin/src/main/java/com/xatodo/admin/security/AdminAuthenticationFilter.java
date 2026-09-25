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
 * 后台接口（{@code /api/v1/admin/**}）的令牌解析。只处理该前缀，不影响 C 端接口。
 */
@Component
public class AdminAuthenticationFilter extends OncePerRequestFilter {

    private static final String BEARER_PREFIX = "Bearer ";
    private static final String ADMIN_PATH_PREFIX = "/api/v1/admin/";

    private final AdminTokenService adminTokenService;

    public AdminAuthenticationFilter(AdminTokenService adminTokenService) {
        this.adminTokenService = adminTokenService;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith(ADMIN_PATH_PREFIX);
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
