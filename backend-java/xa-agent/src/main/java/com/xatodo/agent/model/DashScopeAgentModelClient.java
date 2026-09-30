package com.xatodo.agent.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.xatodo.agent.config.AgentProperties;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.function.Consumer;
import java.util.stream.Stream;

/**
 * 阿里云百炼（通义千问）实现（spec §11 阶段三）。
 *
 * <p>用的是百炼的 **OpenAI 兼容**模式：`POST {base}/chat/completions`，`stream: true`。
 * 自己用 JDK 的 HttpClient 转发 SSE 而不是引 SDK —— 我们只需要「读上游的行、转成事件」，
 * 引一个 SDK 反而多一层版本与依赖负担，换模型也不如直接改配置灵活。
 *
 * <p>几个已实测确认的参数（写死在请求里，避免下个人又踩一遍）：
 * <ul>
 *   <li>`enable_thinking: false`：关掉思考流，省 reasoning token 也省首字时间；</li>
 *   <li>`stream_options.include_usage: true`：最后一帧才会带 token 用量，用于成本观测；</li>
 *   <li>`tool_choice` **不设 `required`**：思考模式下设了会被上游拒绝；</li>
 *   <li>`max_tokens` 用配置值（默认 600）：助手要的是短答案。</li>
 * </ul>
 */
public class DashScopeAgentModelClient implements AgentModelClient {

    private static final Logger log = LoggerFactory.getLogger(DashScopeAgentModelClient.class);

    private final AgentProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient client;

    public DashScopeAgentModelClient(AgentProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    }

    @Override
    public String providerName() {
        return available() ? "dashscope:" + properties.getModel() : "unconfigured";
    }

    @Override
    public boolean available() {
        return properties.configured();
    }

    @Override
    public boolean transcriptionAvailable() {
        return properties.asrConfigured();
    }

    @Override
    public CompletionResult complete(CompletionRequest request, Consumer<String> onTextDelta) {
        if (!available()) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "助手模型未配置");
        }
        HttpRequest httpRequest = HttpRequest.newBuilder(chatUri())
                .timeout(Duration.ofSeconds(properties.getTimeoutSeconds()))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + properties.getApiKey())
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(
                        write(buildChatRequest(request))))
                .build();

        ChatCompletionAccumulator accumulator = new ChatCompletionAccumulator();
        try (Stream<String> lines = client.send(httpRequest, HttpResponse.BodyHandlers.ofLines()).body()) {
            lines.forEach(line -> {
                String data = payloadOf(line);
                if (data == null) {
                    return;
                }
                if ("[DONE]".equals(data)) {
                    return;
                }
                try {
                    String piece = accumulator.accept(objectMapper.readTree(data));
                    if (!piece.isEmpty()) {
                        // 用户已经走了 / 点了停止：回调会抛 AgentStreamAborted，这里直接穿出去
                        onTextDelta.accept(piece);
                    }
                } catch (AgentStreamAborted aborted) {
                    throw aborted;
                } catch (Exception ex) {
                    // 单帧坏了不该废掉整条回答：记一条日志继续读，最后至少还有半句话
                    log.warn("解析上游流式帧失败: {}", ex.getMessage());
                }
            });
        } catch (AgentStreamAborted aborted) {
            throw aborted;
        } catch (IOException ex) {
            throw new UncheckedIOException(ex);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "助手请求被中断");
        }
        return accumulator.result();
    }

    @Override
    public TranscriptionResult transcribe(byte[] audio, String contentType) {
        if (!transcriptionAvailable()) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "语音识别未配置");
        }
        ObjectNode root = objectMapper.createObjectNode();
        root.put("model", properties.getAsr().getModel());
        ObjectNode input = root.putObject("input");
        ArrayNode messages = input.putArray("messages");
        ObjectNode message = messages.addObject();
        message.put("role", "user");
        ArrayNode content = message.putArray("content");
        content.addObject().put("audio",
                "data:" + contentType + ";base64," + Base64.getEncoder().encodeToString(audio));
        if (properties.getAsr().getLanguage() != null && !properties.getAsr().getLanguage().isBlank()) {
            root.putObject("parameters").putObject("asr_options")
                    .put("language", properties.getAsr().getLanguage());
        }

        HttpRequest httpRequest = HttpRequest.newBuilder(URI.create(properties.getAsr().getUrl()))
                .timeout(Duration.ofSeconds(properties.getAsr().getTimeoutSeconds()))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + properties.asrApiKey())
                .POST(HttpRequest.BodyPublishers.ofString(write(root)))
                .build();
        try {
            HttpResponse<String> response = client.send(httpRequest, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                log.warn("语音转写上游返回 HTTP {}: {}", response.statusCode(), abbreviate(response.body()));
                throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                        "语音识别服务返回 HTTP " + response.statusCode());
            }
            return parseTranscription(objectMapper.readTree(response.body()));
        } catch (IOException ex) {
            throw new UncheckedIOException(ex);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "语音识别被中断");
        }
    }

    /**
     * 解析转写响应。
     *
     * <p>兼容两种形状：多模态生成接口的 `output.choices[0].message.content[0].text`，
     * 以及 OpenAI 兼容接口的 `choices[0].message.content`（字符串）。
     * 上游换接口时不必改代码——这两种都是百炼真实存在的返回结构。
     */
    static TranscriptionResult parseTranscription(JsonNode body) {
        JsonNode content = body.path("output").path("choices").path(0).path("message").path("content");
        if (content.isArray()) {
            for (JsonNode part : content) {
                if (part.path("text").isTextual()) {
                    return new TranscriptionResult(part.path("text").asText(), null);
                }
            }
        }
        JsonNode openAiContent = body.path("choices").path(0).path("message").path("content");
        if (openAiContent.isTextual()) {
            return new TranscriptionResult(openAiContent.asText(), null);
        }
        return new TranscriptionResult("", null);
    }

    private ObjectNode buildChatRequest(CompletionRequest request) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("model", properties.getModel());
        root.put("stream", true);
        root.put("enable_thinking", properties.isEnableThinking());
        root.put("max_tokens", properties.getMaxTokens());
        // 最后一帧带上 token 用量：成本要能观测，否则「为什么这个月账单涨了」无处可查
        root.putObject("stream_options").put("include_usage", true);

        ArrayNode messages = root.putArray("messages");
        for (AgentMessage message : request.messages()) {
            messages.add(toWireMessage(message));
        }
        if (request.tools() != null && !request.tools().isEmpty()) {
            ArrayNode tools = root.putArray("tools");
            for (AgentToolSpec spec : request.tools()) {
                ObjectNode function = tools.addObject().put("type", "function").putObject("function");
                function.put("name", spec.name());
                function.put("description", spec.description());
                function.set("parameters", spec.parameters());
            }
        }
        // 排查用：容器里 `touch /tmp/agent-dump-on` 就把真实发给上游的请求打进日志
        // （只在排查重复申请授权这类"上下文形状"问题时打开，正文很长）
        if (new java.io.File("/tmp/agent-dump-on").exists()) {
            log.info("agent upstream request: {}", write(root));
        }
        return root;
    }

    private ObjectNode toWireMessage(AgentMessage message) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("role", message.role());
        if (message.content() != null) {
            node.put("content", message.content());
        }
        if (message.toolCallId() != null) {
            node.put("tool_call_id", message.toolCallId());
        }
        if (message.toolCalls() != null && !message.toolCalls().isEmpty()) {
            ArrayNode calls = node.putArray("tool_calls");
            for (AgentToolCall call : message.toolCalls()) {
                ObjectNode item = calls.addObject();
                item.put("id", call.id());
                item.put("type", "function");
                ObjectNode function = item.putObject("function");
                function.put("name", call.name());
                function.put("arguments", call.arguments() == null ? "{}" : call.arguments());
            }
        }
        return node;
    }

    /** 取一行的 `data:` 载荷；不是数据行（空行、注释、其它字段）返回 null。 */
    static String payloadOf(String line) {
        if (line == null) {
            return null;
        }
        String trimmed = line.strip();
        if (trimmed.isEmpty() || trimmed.startsWith(":")) {
            return null;
        }
        if (!trimmed.startsWith("data:")) {
            return null;
        }
        return trimmed.substring("data:".length()).strip();
    }

    private URI chatUri() {
        String base = properties.getBaseUrl().replaceAll("/+$", "");
        return URI.create(base + "/chat/completions");
    }

    private String write(ObjectNode node) {
        try {
            return objectMapper.writeValueAsString(node);
        } catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
    }

    private static String abbreviate(String body) {
        if (body == null) {
            return "";
        }
        return body.length() <= 300 ? body : body.substring(0, 300) + "…";
    }

    /** 供日志：把消息列表压成一行摘要，避免整段对话进日志。 */
    static String summarize(List<AgentMessage> messages) {
        return "messages=" + messages.size();
    }
}
