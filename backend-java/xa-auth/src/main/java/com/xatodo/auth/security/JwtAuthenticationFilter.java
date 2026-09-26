package com.xatodo.auth.security;

import com.xatodo.auth.service.TokenService;
import com.xatodo.common.api.ErrorCode;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.JwtException;
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
 * 解析 {@code Authorization: Bearer <access_token>} 并写入安全上下文。
 *
 * <p>只接受 {@link TokenScope#ACCESS} 令牌；注册令牌与选择身份令牌由对应接口自行校验。
 * 解析失败时不直接返回响应，而是记录原因，交由 {@code AuthenticationEntryPoint} 统一输出。
 */
@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private static final String BEARER_PREFIX = "Bearer ";
    private static final String ADMIN_PATH_PREFIX = "/api/v1/admin/";

    private final TokenService tokenService;

    public JwtAuthenticationFilter(TokenService tokenService) {
        this.tokenService = tokenService;
    }

    /**
     * 后台接口由 {@code AdminAuthenticationFilter} 负责，两边路径互斥，避免令牌语义互相干扰。
     *
     * <p>例外是组织管理端前缀 {@code /org-admin/**}：它既服务后台组织管理员，也服务 App 里的组织身份，
     * 因此两个过滤器都会尝试解析，谁能解析成功谁就把认证写进上下文。
     */
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getRequestURI().startsWith(ADMIN_PATH_PREFIX);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (StringUtils.hasText(header) && header.startsWith(BEARER_PREFIX)) {
            String token = header.substring(BEARER_PREFIX.length()).trim();
            try {
                IdentityPrincipal principal = tokenService.parseAccessToken(token);
                UsernamePasswordAuthenticationToken authentication =
                        new UsernamePasswordAuthenticationToken(
                                principal, null, List.of(new SimpleGrantedAuthority("ROLE_IDENTITY")));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            } catch (ExpiredJwtException ex) {
                request.setAttribute(AuthAttributes.AUTH_ERROR_CODE, ErrorCode.TOKEN_EXPIRED);
            } catch (JwtException | IllegalArgumentException ex) {
                request.setAttribute(AuthAttributes.AUTH_ERROR_CODE, ErrorCode.UNAUTHENTICATED);
            }
        }
        filterChain.doFilter(request, response);
    }
}
