package com.xatodo.bootstrap.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.xatodo.auth.security.AuthAttributes;
import com.xatodo.auth.security.JwtAuthenticationFilter;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.common.api.ErrorCode;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

import java.io.IOException;

/**
 * 安全配置：无状态 JWT 体系（spec §3.5）。
 *
 * <p>放行健康检查、接口文档与系统探活接口，其余接口一律要求认证。
 * 认证与鉴权失败时同样返回统一响应体结构。
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   ObjectMapper objectMapper,
                                                   JwtAuthenticationFilter jwtAuthenticationFilter) throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .cors(Customizer.withDefaults())
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(registry -> registry
                        .requestMatchers("/api/v1/system/**").permitAll()
                        .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                        .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                        // 登录链路的入口接口自身校验受限令牌（注册令牌 / 选择身份令牌 / 刷新令牌）
                        .requestMatchers(
                                "/api/v1/auth/sms/**",
                                "/api/v1/auth/login/**",
                                "/api/v1/auth/token/**",
                                "/api/v1/auth/logout",
                                "/api/v1/auth/identity/select",
                                "/api/v1/auth/identity/switch",
                                "/api/v1/identities/personal")
                        .permitAll()
                        .anyRequest().authenticated())
                .exceptionHandling(handling -> handling
                        .authenticationEntryPoint(restAuthenticationEntryPoint(objectMapper))
                        .accessDeniedHandler(restAccessDeniedHandler(objectMapper)))
                .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }

    private AuthenticationEntryPoint restAuthenticationEntryPoint(ObjectMapper objectMapper) {
        return (request, response, authException) -> {
            Object cause = request.getAttribute(AuthAttributes.AUTH_ERROR_CODE);
            ErrorCode errorCode = cause instanceof ErrorCode code ? code : ErrorCode.UNAUTHENTICATED;
            writeError(response, objectMapper, HttpServletResponse.SC_UNAUTHORIZED, errorCode);
        };
    }

    private AccessDeniedHandler restAccessDeniedHandler(ObjectMapper objectMapper) {
        return (request, response, accessDeniedException) ->
                writeError(response, objectMapper, HttpServletResponse.SC_FORBIDDEN, ErrorCode.FORBIDDEN);
    }

    private void writeError(HttpServletResponse response,
                            ObjectMapper objectMapper,
                            int httpStatus,
                            ErrorCode errorCode) throws IOException {
        response.setStatus(httpStatus);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        objectMapper.writeValue(response.getWriter(), ApiResponse.failure(errorCode));
    }
}
