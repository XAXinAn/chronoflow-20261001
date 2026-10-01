package com.chronoflow.bootstrap.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.admin.security.AdminAuthenticationFilter;
import com.chronoflow.auth.security.AuthAttributes;
import com.chronoflow.auth.security.JwtAuthenticationFilter;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.common.api.ErrorCode;
import jakarta.servlet.DispatcherType;
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
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

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

    /**
     * 密码哈希统一在这里定义：C 端账号密码与后台管理员共用同一实现，
     * 避免各模块重复声明导致 bean 冲突（spec §7.1 要求 BCrypt cost ≥ 10）。
     */
    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(10);
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   ObjectMapper objectMapper,
                                                   JwtAuthenticationFilter jwtAuthenticationFilter,
                                                   AdminAuthenticationFilter adminAuthenticationFilter)
            throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .cors(Customizer.withDefaults())
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(registry -> registry
                        /*
                         * 异步分派（ASYNC）与错误分派（ERROR）**不再走鉴权**。
                         *
                         * <p>Spring Security 6 起，AuthorizationFilter 默认对所有 dispatcher type 生效。
                         * 而 SSE / DeferredResult 这种异步响应在收尾时，容器会把**同一个请求**
                         * 再派发一次；这次再派发没有 SecurityContext，于是必然 Access Denied。
                         * 此时响应已经提交（响应头早就发给客户端了），错误页写不进去，
                         * 容器只能把连接硬切断 —— 客户端看到的是「流被中断」
                         * （实测：curl 退出码 18 / transfer closed with outstanding read data remaining）。
                         *
                         * <p>放行它们是安全的：真正决定能不能进来的始终是**第一次** REQUEST 派发，
                         * 那一次照样要过完整套鉴权规则。
                         */
                        .dispatcherTypeMatchers(DispatcherType.ASYNC, DispatcherType.ERROR).permitAll()
                        .requestMatchers("/api/v1/system/**").permitAll()
                        .requestMatchers("/api/v1/admin/auth/login").permitAll()
                        .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                        .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                        // 地图选点页：由 WebView 直接按 URL 加载，带不了 Authorization；
                        // 页面本身只有地图和公开的 JS Key，不含任何用户数据
                        .requestMatchers("/map/**").permitAll()
                        // 上传目录：<Image> 直接按 URL 取图，同样带不了 Authorization（spec §5.10）。
                        // 代价是这里不能放任何私有内容——只有头像与反馈图片走这条路
                        .requestMatchers("/uploads/**").permitAll()
                        // 合规文本（隐私政策 / 用户协议 / 儿童声明 / 双清单）：
                        // 商店的自动化检测要能**不登录直接抓**，应用内也是 WebView 按 URL 打开，
                        // 因此必须公开。页面里没有脚本、也没有任何用户数据（docs/legal/*.md）。
                        .requestMatchers("/api/v1/legal/**").permitAll()
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
                // 两个自定义过滤器锚定同一个标准过滤器；它们通过 shouldNotFilter 各自跳过对方路径，
                // 因此相互顺序无关紧要（也避免了对未注册的自定义过滤器做排序而报错）。
                .addFilterBefore(adminAuthenticationFilter, UsernamePasswordAuthenticationFilter.class)
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
