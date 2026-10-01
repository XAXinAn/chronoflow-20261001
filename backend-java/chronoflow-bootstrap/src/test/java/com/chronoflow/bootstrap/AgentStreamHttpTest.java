package com.chronoflow.bootstrap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.agent.model.AgentModelClient;
import com.chronoflow.agent.model.CompletionRequest;
import com.chronoflow.agent.model.CompletionResult;
import com.chronoflow.agent.model.ModelUsage;
import com.chronoflow.agent.model.TranscriptionResult;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.function.Consumer;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SSE 必须能**经真实 Tomcat 收尾**（spec §11 阶段三）。
 *
 * <p>为什么不能只用 MockMvc：异步响应在收尾时，容器会把同一个请求**再派发一次**，
 * 那一次会重新过一遍过滤器链。项目里第一个 SSE 端点上线时就踩到了这一点——
 * Spring Security 6 默认对 ASYNC 派发也做鉴权，再派发时没有 SecurityContext，直接 Access Denied；
 * 此时响应已提交，错误页写不进去，容器只能硬切连接，客户端报「流中断」
 * （curl 退出码 18 / transfer closed with outstanding read data remaining）。
 *
 * <p>MockMvc 的异步是模拟的，看不到这件事；所以这里起**真端口**，
 * 用 JDK HttpClient 真读一遍流：读到 `event:done` 且**读到最后不抛异常**才算过。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AgentStreamHttpTest {

    /** 一句话就收尾的假模型：这个用例只关心「流能不能正常结束」。 */
    static final class FakeModel implements AgentModelClient {

        @Override
        public String providerName() {
            return "fake";
        }

        @Override
        public boolean available() {
            return true;
        }

        @Override
        public boolean transcriptionAvailable() {
            return true;
        }

        @Override
        public CompletionResult complete(CompletionRequest request, Consumer<String> onTextDelta) {
            onTextDelta.accept("好的。");
            return new CompletionResult("好的。", List.of(), "stop", new ModelUsage(1, 1));
        }

        @Override
        public TranscriptionResult transcribe(byte[] audio, String contentType) {
            return new TranscriptionResult("", null);
        }
    }

    @TestConfiguration
    static class FakeModelConfig {

        @Bean
        @Primary
        FakeModel fakeAgentModelClient() {
            return new FakeModel();
        }
    }

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;

    @LocalServerPort
    private int port;

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

    @Test
    @DisplayName("对话流经真实容器收尾：读到最后不报错，且带 done 事件")
    void streamEndsCleanlyThroughRealContainer() throws Exception {
        String token = register();

        HttpRequest request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v1/ai/agent/chat"))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(
                        "{\"messages\":[{\"role\":\"user\",\"content\":\"在吗\"}]}"))
                .build();

        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        HttpResponse<Stream<String>> response = client.send(request, HttpResponse.BodyHandlers.ofLines());
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("content-type").orElse(""))
                .contains("text/event-stream");
        assertThat(response.headers().firstValue("x-accel-buffering").orElse("")).isEqualTo("no");

        List<String> lines;
        // 读不完就会在这里抛 IOException —— 那正是「连接被硬切」的表现
        try (Stream<String> body = response.body()) {
            lines = body.toList();
        }
        assertThat(String.join("\n", lines)).contains("event:done").contains("好的");
    }

    // ---------------------------------------------------------------- helpers

    private String register() throws Exception {
        JsonNode code = post("/api/v1/auth/sms/code", null, "{\"phone\":\"13800000701\"}");
        JsonNode login = post("/api/v1/auth/login/sms", null,
                "{\"phone\":\"13800000701\",\"code\":\""
                        + code.path("data").path("debugCode").asText() + "\",\"deviceId\":\"d1\"}");
        JsonNode created = post("/api/v1/identities/personal",
                login.path("data").path("registerToken").asText(),
                "{\"nickname\":\"流式用户\",\"deviceId\":\"d1\"}");
        return created.path("data").path("accessToken").asText();
    }

    private JsonNode post(String path, String token, String body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/json");
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        HttpResponse<String> response = HttpClient.newHttpClient()
                .send(builder.POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                        HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        return objectMapper.readTree(response.body());
    }
}
