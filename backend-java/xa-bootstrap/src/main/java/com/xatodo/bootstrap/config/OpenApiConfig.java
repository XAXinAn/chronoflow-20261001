package com.xatodo.bootstrap.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * OpenAPI 3 文档配置（spec §6.1）。
 */
@Configuration
public class OpenApiConfig {

    private static final String BEARER_SCHEME = "bearerAuth";

    @Value("${xatodo.version:0.1.0-SNAPSHOT}")
    private String version;

    @Bean
    public OpenAPI xaTodoOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("时纪流 API")
                        .description("时纪流（ChronoFlow）后端接口。统一前缀 /api/v1，统一响应体 {code, message, data, traceId}。")
                        .version(version))
                // 刻意不设全局安全声明：否则公开接口（发验证码、登录）也会被标注为需要鉴权，
                // 这份文档要给阶段二的 Python 版照着实现，不能有误导。
                .components(new Components().addSecuritySchemes(BEARER_SCHEME,
                        new SecurityScheme()
                                .name(BEARER_SCHEME)
                                .type(SecurityScheme.Type.HTTP)
                                .scheme("bearer")
                                .bearerFormat("JWT")));
    }
}
