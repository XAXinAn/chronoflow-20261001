package com.chronoflow.bootstrap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * API 契约校验（spec §10.1）。
 *
 * <p>契约文件位于仓库根目录 {@code contract/api-contract.json}，由 Java 版与阶段二的 Python 版**共同**校验。
 * 这里做两件事：
 * <ol>
 *   <li>OpenAPI 文档必须覆盖契约里列出的每个 方法 + 路径，且安全声明与实际鉴权一致；</li>
 *   <li>未携带令牌实际发一次请求，验证受保护接口确实返回 401、公开接口确实不返回 401。</li>
 * </ol>
 * 第 2 点是行为验证而非文档验证——注解写错了这里也会失败。
 */
@SpringBootTest
@AutoConfigureMockMvc
class OpenApiContractTest {

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @DynamicPropertySource
    static void dependencies(DynamicPropertyRegistry registry) throws IOException {
        postgres = EmbeddedPostgres.builder().start();
        int redisPort = findFreePort();
        redisServer = RedisServer.newRedisServer().port(redisPort).build();
        redisServer.start();

        registry.add("spring.datasource.url", () -> postgres.getJdbcUrl("postgres", "postgres"));
        registry.add("spring.datasource.username", () -> "postgres");
        registry.add("spring.datasource.password", () -> "postgres");
        registry.add("spring.data.redis.port", () -> redisPort);
        registry.add("chronoflow.auth.expose-sms-code", () -> true);
    }

    private static int findFreePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    @AfterAll
    static void shutdown() throws IOException {
        if (redisServer != null) {
            redisServer.stop();
        }
        if (postgres != null) {
            postgres.close();
        }
    }

    private JsonNode contract() throws IOException {
        try (var stream = getClass().getResourceAsStream("/api-contract.json")) {
            assertThat(stream).as("classpath 上找不到 api-contract.json").isNotNull();
            return objectMapper.readTree(stream);
        }
    }

    private JsonNode openApiDocument() throws Exception {
        String body = mockMvc.perform(get("/v3/api-docs"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(body);
    }

    @Test
    @DisplayName("OpenAPI 文档覆盖契约中的每个方法 + 路径")
    void openApiCoversEveryContractEndpoint() throws Exception {
        JsonNode openApi = openApiDocument();
        JsonNode paths = openApi.path("paths");
        assertThat(paths.isMissingNode()).as("OpenAPI 文档缺少 paths").isFalse();

        List<String> missing = new ArrayList<>();
        for (JsonNode endpoint : contract().path("endpoints")) {
            String method = endpoint.path("method").asText().toLowerCase();
            String path = endpoint.path("path").asText();
            if (paths.path(path).path(method).isMissingNode()) {
                missing.add(endpoint.path("method").asText() + " " + path);
            }
        }

        assertThat(missing).as("以下契约端点未出现在 OpenAPI 文档中").isEmpty();
    }

    @Test
    @DisplayName("OpenAPI 安全声明与契约一致：受保护接口有声明，公开接口没有")
    void openApiSecurityMatchesContract() throws Exception {
        JsonNode paths = openApiDocument().path("paths");
        List<String> mismatched = new ArrayList<>();

        for (JsonNode endpoint : contract().path("endpoints")) {
            String method = endpoint.path("method").asText().toLowerCase();
            String path = endpoint.path("path").asText();
            boolean requiresAuth = "access".equals(endpoint.path("auth").asText());
            JsonNode security = paths.path(path).path(method).path("security");
            boolean declared = security.isArray() && !security.isEmpty();
            if (requiresAuth != declared) {
                mismatched.add(endpoint.path("method").asText() + " " + path
                        + "（契约要求 " + (requiresAuth ? "需要鉴权" : "公开")
                        + "，文档声明为 " + (declared ? "需要鉴权" : "公开") + "）");
            }
        }

        assertThat(mismatched).as("安全声明与契约不一致").isEmpty();
    }

    @Test
    @DisplayName("未携带令牌时，受保护接口返回 401、公开接口不返回 401")
    void authEnforcementMatchesContract() throws Exception {
        List<String> violations = new ArrayList<>();

        for (JsonNode endpoint : contract().path("endpoints")) {
            String method = endpoint.path("method").asText();
            String path = endpoint.path("path").asText().replaceAll("\\{[^}]+}", "1");
            boolean requiresAuth = "access".equals(endpoint.path("auth").asText());

            int status = mockMvc.perform(builderFor(method, path)).andReturn().getResponse().getStatus();
            if (requiresAuth && status != 401) {
                violations.add(method + " " + path + " 需要鉴权却返回 HTTP " + status);
            }
            if (!requiresAuth && status == 401) {
                violations.add(method + " " + path + " 应公开却被要求鉴权");
            }
        }

        assertThat(violations).as("鉴权行为与契约不符").isEmpty();
    }

    @Test
    @DisplayName("导出生成的 OpenAPI 文档，供阶段二 Python 版对照")
    void exportOpenApiDocument() throws Exception {
        JsonNode openApi = openApiDocument();
        int endpointCount = 0;
        for (JsonNode pathItem : openApi.path("paths")) {
            endpointCount += pathItem.size();
        }
        assertThat(endpointCount).as("OpenAPI 文档中的端点数量过少，疑似生成失败").isGreaterThan(50);

        Path output = Path.of("target", "openapi", "chronoflow-api.json");
        Files.createDirectories(output.getParent());
        Files.writeString(output, objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(openApi));
        assertThat(Files.exists(output)).isTrue();
    }

    private MockHttpServletRequestBuilder builderFor(String method, String path) {
        boolean hasBody = method.equals("POST") || method.equals("PATCH") || method.equals("PUT");
        MockHttpServletRequestBuilder builder = switch (method) {
            case "GET" -> get(path);
            case "POST" -> post(path);
            case "PATCH" -> patch(path);
            case "PUT" -> put(path);
            case "DELETE" -> delete(path);
            default -> throw new IllegalArgumentException("未支持的 HTTP 方法: " + method);
        };
        if (hasBody) {
            builder.contentType(MediaType.APPLICATION_JSON).content("{}");
        }
        return builder;
    }
}
