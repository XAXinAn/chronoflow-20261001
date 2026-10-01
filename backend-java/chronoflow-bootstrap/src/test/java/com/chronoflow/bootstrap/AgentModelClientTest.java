package com.chronoflow.bootstrap;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.chronoflow.agent.config.AgentProperties;
import com.chronoflow.agent.model.AgentMessage;
import com.chronoflow.agent.model.AgentModelClient;
import com.chronoflow.agent.model.AgentToolCall;
import com.chronoflow.agent.model.AgentToolSpec;
import com.chronoflow.agent.model.CompletionRequest;
import com.chronoflow.agent.model.CompletionResult;
import com.chronoflow.agent.model.DashScopeAgentModelClient;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 上游流式帧的解析（spec §11 阶段三）。
 *
 * <p>不用真实模型：**模型本身不是要测的东西**，要测的是我们这一侧——
 * 分片的 `tool_calls` 参数能不能拼回一句完整 JSON、`data:` 前缀与 `[DONE]` 有没有认出来、
 * 最后一帧的 usage 有没有收到。所以这里用 JDK 自带的 HttpServer 起一个假的 OpenAI 兼容端点。
 */
class AgentModelClientTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private HttpServer server;
    private final List<String> requestBodies = new ArrayList<>();

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("正文增量按顺序拼起来；工具调用的参数分片跨帧拼接")
    void assemblesDeltasAndToolCalls() throws Exception {
        serveSse("""
                data: {"choices":[{"delta":{"content":"你明天"},"finish_reason":null}]}

                data: {"choices":[{"delta":{"content":"下午没有安排。"},"finish_reason":null}]}

                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_events","arguments":""}}]},"finish_reason":null}]}

                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"keyword\\":"}}]},"finish_reason":null}]}

                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"评审\\"}"}}]},"finish_reason":null}]}

                data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

                data: {"choices":[],"usage":{"prompt_tokens":812,"completion_tokens":96}}

                data: [DONE]

                """);

        List<String> deltas = new ArrayList<>();
        CompletionResult result = client().complete(
                new CompletionRequest(
                        List.of(AgentMessage.user("我明天下午有空吗")),
                        List.of(toolSpec())),
                deltas::add);

        assertThat(deltas).containsExactly("你明天", "下午没有安排。");
        assertThat(result.text()).isEqualTo("你明天下午没有安排。");
        assertThat(result.finishReason()).isEqualTo("tool_calls");
        assertThat(result.toolCalls()).hasSize(1);
        AgentToolCall call = result.toolCalls().get(0);
        assertThat(call.id()).isEqualTo("call_1");
        assertThat(call.name()).isEqualTo("list_events");
        // 参数是分三帧给的，拼起来必须是一个合法对象
        assertThat(objectMapper.readTree(call.arguments()).path("keyword").asText()).isEqualTo("评审");
        assertThat(result.usage().promptTokens()).isEqualTo(812);
        assertThat(result.usage().completionTokens()).isEqualTo(96);
    }

    @Test
    @DisplayName("请求体里关掉思考、带上用量选项，且不设 tool_choice（思考模式下会被上游拒绝）")
    void sendsExpectedUpstreamParameters() throws Exception {
        serveSse("""
                data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}

                data: [DONE]

                """);

        client().complete(new CompletionRequest(
                List.of(AgentMessage.system("系统提示"), AgentMessage.user("在吗")),
                List.of(toolSpec())), text -> { });

        var body = objectMapper.readTree(requestBodies.get(0));
        assertThat(body.path("model").asText()).isEqualTo("qwen3.6-flash");
        assertThat(body.path("stream").asBoolean()).isTrue();
        assertThat(body.path("enable_thinking").asBoolean()).isFalse();
        assertThat(body.path("max_tokens").asInt()).isEqualTo(600);
        assertThat(body.path("stream_options").path("include_usage").asBoolean()).isTrue();
        assertThat(body.has("tool_choice")).as("思考模式下设 tool_choice 会被上游拒绝").isFalse();
        assertThat(body.path("messages").get(0).path("role").asText()).isEqualTo("system");
        assertThat(body.path("tools").get(0).path("function").path("name").asText())
                .isEqualTo("list_events");
    }

    @Test
    @DisplayName("每一帧都带 \"id\":\"\" 时，真实 id 不能被冲掉（百炼的实际行为）")
    void keepsFirstToolCallIdWhenLaterFramesSendEmptyId() throws Exception {
        // 这几帧是从真实上游抓下来的形状：第一帧给 id，后面每帧都回一个空 id
        serveSse("""
                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_real_1","type":"function","function":{"name":"create_event","arguments":""}}]},"finish_reason":null}]}

                data: {"choices":[{"delta":{"tool_calls":[{"id":"","type":"function","index":0,"function":{"arguments":""}}]},"finish_reason":null}]}

                data: {"choices":[{"delta":{"tool_calls":[{"id":"","type":"function","index":0,"function":{"arguments":"{\\"title\\": \\"张总会\\"}"}}]},"finish_reason":null}]}

                data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

                data: [DONE]

                """);

        CompletionResult result = client().complete(
                new CompletionRequest(List.of(AgentMessage.user("建个日程")), List.of(toolSpec())),
                text -> { });

        assertThat(result.toolCalls()).hasSize(1);
        assertThat(result.toolCalls().get(0).id())
                .as("回灌工具结果要靠这个 id，被空串冲掉就白查了")
                .isEqualTo("call_real_1");
        assertThat(result.toolCalls().get(0).name()).isEqualTo("create_event");
        assertThat(objectMapper.readTree(result.toolCalls().get(0).arguments()).path("title").asText())
                .isEqualTo("张总会");
    }

    @Test
    @DisplayName("未配置 api-key 时不开流：available() 为 false")
    void unconfiguredClientIsNotAvailable() {
        AgentProperties properties = new AgentProperties();
        properties.setBaseUrl("http://127.0.0.1:1/v1");
        AgentModelClient client = new DashScopeAgentModelClient(properties, objectMapper);

        assertThat(client.available()).isFalse();
        assertThat(client.transcriptionAvailable()).isFalse();
        assertThat(client.providerName()).isEqualTo("unconfigured");
    }

    // ---------------------------------------------------------------- helpers

    private AgentModelClient client() {
        AgentProperties properties = new AgentProperties();
        properties.setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1");
        properties.setApiKey("test-key");
        properties.setModel("qwen3.6-flash");
        return new DashScopeAgentModelClient(properties, objectMapper);
    }

    private static AgentToolSpec toolSpec() {
        return new AgentToolSpec("list_events", "查日程",
                new ObjectMapper().createObjectNode().put("type", "object"));
    }

    private void serveSse(String body) {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/v1/chat/completions", (HttpExchange exchange) -> {
                requestBodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, payload.length);
                exchange.getResponseBody().write(payload);
                exchange.close();
            });
            server.start();
        } catch (IOException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
