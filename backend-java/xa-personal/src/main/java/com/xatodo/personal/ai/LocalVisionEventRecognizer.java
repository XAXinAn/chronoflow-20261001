package com.xatodo.personal.ai;

import com.fasterxml.jackson.core.json.JsonReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * 本地轻量多模态实现（spec §4.1.9）：把图片发给**本机 / 内网**的 OpenAI 兼容推理服务。
 *
 * <p>为什么用这个协议而不是绑某个模型：Ollama、vLLM、LM Studio 都能起 `/v1/chat/completions`，
 * 换模型只改配置（`xatodo.ai.vision.model`），代码与 App 都不用动；而且地址在本地，
 * 日程照片不出内网。
 *
 * <p><b>「一定拿到我们要的 JSON」分四层保障</b>（只靠提示词是不够的）：
 * <ol>
 *   <li><b>约束解码</b>：请求里带 `response_format`（JSON 模式，或带 schema 的严格模式），
 *       让采样阶段就受约束——这是最有效的一层；</li>
 *   <li><b>提示词</b>里写清结构，并要求「一图多活动」「看不清时间不要猜」；</li>
 *   <li><b>容错解析</b>：代码块、前后夹带的解释、单引号、尾逗号、单个对象而不是数组，
 *       这些都按网上通行的做法先剥再解析；</li>
 *   <li><b>修复重试</b>：还是解析不出来，就把上一次的坏输出回灌给模型让它只输出 JSON；
 *       再失败就<b>明确报 90002</b>——绝不让格式不对的结果流到 App。</li>
 * </ol>
 */
@Component
public class LocalVisionEventRecognizer implements VisionEventRecognizer {

    private static final Logger log = LoggerFactory.getLogger(LocalVisionEventRecognizer.class);

    private final VisionProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient client;
    /**
     * 解析模型回复用的宽松解析器。
     *
     * <p>模型经常「只是不太老实」：前后带一句解释、用单引号、多一个尾逗号。
     * 这些都不该让整次识别失败，所以这里显式允许它们；
     * 真正越界的（根本不是 JSON）交给「修复重试 + 明确报错」，不做无原则的兜底。
     */
    private final ObjectMapper lenientMapper = JsonMapper.builder()
            .enable(JsonReadFeature.ALLOW_TRAILING_COMMA)
            .enable(JsonReadFeature.ALLOW_SINGLE_QUOTES)
            .enable(JsonReadFeature.ALLOW_UNQUOTED_FIELD_NAMES)
            .enable(JsonReadFeature.ALLOW_JAVA_COMMENTS)
            .build();

    public LocalVisionEventRecognizer(VisionProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    }

    @Override
    public String providerName() {
        return properties.configured() ? "local-vision" : "unconfigured";
    }

    @Override
    public boolean configured() {
        return properties.configured();
    }

    @Override
    public List<RecognizedEvent> recognize(byte[] image, String contentType,
                                           String today, String timezone) {
        if (!configured()) {
            // 明确报「未配置」，不要返回空列表冒充「图里没有日程」——后者会让用户反复重拍
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "识别服务未配置（spec §4.1.9）：请在后端配置本地多模态模型");
        }

        String previousReply = null;
        int attempts = Math.max(1, properties.getMaxAttempts());
        for (int attempt = 1; attempt <= attempts; attempt++) {
            try {
                String reply = call(image, contentType, today, timezone, previousReply);
                return parseItems(reply, timezone);
            } catch (BizException ex) {
                throw ex;
            } catch (Exception ex) {
                previousReply = ex instanceof NotJson ? ((NotJson) ex).rawReply() : null;
                log.warn("识别结果第 {} 次解析失败（{}）", attempt, ex.getMessage());
                if (attempt == attempts) {
                    throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                            "识别结果不是合法 JSON，已重试 " + attempts + " 次");
                }
            }
        }
        throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "识别失败");
    }

    /** 单次调用：图片 + （可选）上一次的坏输出，让模型自己修。 */
    private String call(byte[] image, String contentType, String today, String timezone,
                        String previousReply) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(uri())
                .timeout(Duration.ofSeconds(properties.getTimeoutSeconds()))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + properties.getApiKey())
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(
                        buildRequest(image, contentType, today, timezone, previousReply))))
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "识别服务返回 HTTP " + response.statusCode());
        }
        return objectMapper.readTree(response.body())
                .path("choices").path(0).path("message").path("content").asText("");
    }

    private URI uri() {
        String base = properties.getBaseUrl().endsWith("/")
                ? properties.getBaseUrl().substring(0, properties.getBaseUrl().length() - 1)
                : properties.getBaseUrl();
        return URI.create(base + "/chat/completions");
    }

    private ObjectNode buildRequest(byte[] image, String contentType, String today, String timezone,
                                    String previousReply) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("model", properties.getModel());
        // 关掉流式：我们只要一次性结果，流式反而增加解析复杂度
        root.put("stream", false);
        applyStructuredOutput(root);

        ArrayNode messages = root.putArray("messages");
        ObjectNode user = messages.addObject();
        user.put("role", "user");
        ArrayNode content = user.putArray("content");
        ObjectNode text = content.addObject();
        text.put("type", "text");
        text.put("text", prompt(today, timezone, previousReply));
        ObjectNode picture = content.addObject();
        picture.put("type", "image_url");
        picture.putObject("image_url").put("url",
                "data:" + contentType + ";base64," + Base64.getEncoder().encodeToString(image));
        return root;
    }

    /**
     * 结构化输出约束。
     *
     * <p>`json_schema` 是最强的一层（连字段名都锁死），但不是所有本地服务都实现了；
     * 所以默认用兼容面最广的 `json_object`，需要更严的部署可以切过去。
     */
    private void applyStructuredOutput(ObjectNode root) {
        String mode = properties.getStructuredOutput() == null
                ? "json_object"
                : properties.getStructuredOutput().trim().toLowerCase();
        switch (mode) {
            case "json_schema" -> root.set("response_format", schemaFormat());
            case "none" -> {
                // 只靠提示词：留给排查兼容性问题用
            }
            default -> root.putObject("response_format").put("type", "json_object");
        }
    }

    private ObjectNode schemaFormat() {
        ObjectNode format = objectMapper.createObjectNode();
        format.put("type", "json_schema");
        ObjectNode wrapper = format.putObject("json_schema");
        wrapper.put("name", "recognized_events");
        wrapper.put("strict", true);
        ObjectNode schema = wrapper.putObject("schema");
        schema.put("type", "object");
        ObjectNode propertiesNode = schema.putObject("properties");
        propertiesNode.putObject("events").put("type", "array").putObject("items")
                .put("type", "object");
        schema.putArray("required").add("events");
        return format;
    }

    /** 提示词：强调「一图多活动」「看不清时间就留空」，并给出目标结构。 */
    private String prompt(String today, String timezone, String previousReply) {
        String base = """
                你是日程识别助手。今天是 %s，时区是 %s。
                从图片里找出**所有**日程与待办事项，只输出 JSON，不要解释、不要 markdown 代码块：
                {"events":[{"title":"...","kind":"EVENT","at":"YYYY-MM-DDTHH:mm:ss+08:00",\
                "location":"...","description":"...","confidence":0.9}]}
                规则：
                1. 一张图里可能有多场活动，**全部列出**，不要合并成一条；
                2. kind 只能是 EVENT（日程）或 TASK（一件要去做的事）：
                   通知里的「假期 9/25–9/27」是 EVENT，「登记截止 9/24」「提交材料」这类是 TASK；
                3. **日程与待办都只有一个时间**，放 at：「明天下午三点开会」→ at 给那天的 15:00；
                   「登记截止 9/24」→ at 给 2026-09-24T23:59:00+08:00；
                   时间看不清就留空字符串，**不要猜**；
                4. 「明天下午三点」这类相对时间，按上面的今天与时区换算成绝对时间；
                5. **时间段**（「假期 9/25–9/27」「下午三点到五点」）只记**起始那一刻**：
                   at 给 09-25T00:00:00+08:00 或 15:00（只说了哪天的，给当天 00:00）；
                6. 通知正文里的地址、网址、要求放进 description，标题只写这件事本身；
                7. 认不出的字段留空字符串。
                """.formatted(today, timezone);
        if (previousReply == null) {
            // 结构化输出最糟的失败方式是「看起来有字段、其实全是幻觉」，这里明确禁止脑补
            return base + "8. 不确定的字段宁可留空，**不要编造**。\n";
        }
        // 修复重试：把坏输出原样回灌，明确要求只回 JSON——比重新描述任务有效得多
        return base + """

                上一次的输出不是合法 JSON，无法解析。原始输出如下（可能含解释文字或格式错误）：
                <bad_output>
                %s
                </bad_output>
                请**只**重新输出修正后的 JSON（同一个结构，不要任何解释、不要代码块标记）。
                """.formatted(previousReply);
    }

    /** 解析回复 → 条目。任何一步失败都抛异常，由上层决定重试还是报错。 */
    private List<RecognizedEvent> parseItems(String rawReply, String timezone) throws Exception {
        String json = extractJson(rawReply);
        JsonNode payload = lenientMapper.readTree(json);
        JsonNode events = payload.isArray() ? payload
                : payload.has("events") ? payload.path("events")
                // 模型只给了一条、直接返回对象的情况：包一层而不是判失败
                : payload.has("title") ? lenientMapper.createArrayNode().add(payload)
                : null;
        if (events == null || !events.isArray()) {
            throw new NotJson(rawReply, "回复里没有 events 数组");
        }

        ZoneId zone = ZoneId.of(timezone);
        List<RecognizedEvent> result = new ArrayList<>();
        for (JsonNode node : events) {
            String title = text(node, "title");
            if (title == null || title.isBlank()) {
                continue;
            }
            String atText = text(node, "at") != null ? text(node, "at")
                    // 老模型仍会按 startAt 回：兼容一下，别丢整条
                    : text(node, "startAt");
            result.add(new RecognizedEvent(
                    title.trim(),
                    parseKind(text(node, "kind"), node.path("at")),
                    parseTime(atText, zone),
                    blankToNull(text(node, "location")),
                    blankToNull(text(node, "description")),
                    parseDouble(node.path("confidence"))));
        }
        return result;
    }

    /**
     * 从回复里抠出 JSON（网上通行做法的核心三步）：
     * 去掉 ``` 围栏 → 从第一个花括号/方括号切到最后一个闭合符 → 交给宽松解析器。
     */
    static String extractJson(String rawReply) {
        String text = rawReply == null ? "" : rawReply.trim();
        if (text.startsWith("```")) {
            int firstBreak = text.indexOf('\n');
            int lastFence = text.lastIndexOf("```");
            if (firstBreak > 0 && lastFence > firstBreak) {
                text = text.substring(firstBreak + 1, lastFence).trim();
            }
        }
        int objectStart = text.indexOf('{');
        int arrayStart = text.indexOf('[');
        int start = objectStart < 0 ? arrayStart
                : arrayStart < 0 ? objectStart
                : Math.min(objectStart, arrayStart);
        if (start < 0) {
            throw new NotJson(rawReply, "回复里找不到 JSON");
        }
        char opening = text.charAt(start);
        char closing = opening == '{' ? '}' : ']';
        int end = text.lastIndexOf(closing);
        if (end < start) {
            throw new NotJson(rawReply, "JSON 不完整");
        }
        return text.substring(start, end + 1);
    }

    private static OffsetDateTime parseTime(String raw, ZoneId zone) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String value = raw.trim();
        try {
            return OffsetDateTime.parse(value);
        } catch (Exception ignored) {
            // 继续尝试下面几种：模型常给「2026-09-26 15:00」这种没有偏移量的形式
        }
        try {
            return LocalDateTime.parse(value.replace(' ', 'T')).atZone(zone).toOffsetDateTime();
        } catch (Exception ignored) {
            // 再试「只给日期」的形式（只说了哪天的）
        }
        try {
            return LocalDate.parse(value.substring(0, 10)).atStartOfDay(zone).toOffsetDateTime();
        } catch (Exception ignored) {
            // 再试纯数字时间戳（有些模型会这么返回）
        }
        try {
            long epochSeconds = Long.parseLong(value);
            return OffsetDateTime.ofInstant(Instant.ofEpochSecond(epochSeconds), zone);
        } catch (Exception ex) {
            // 实在解析不了就当「没看出时间」，让用户补，而不是丢掉整条
            return null;
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        // 模型有时把数字/布尔写成字符串，有时反过来：统一按文本取
        return value.isValueNode() ? value.asText() : null;
    }

    private static Double parseDouble(JsonNode value) {
        if (value.isNumber()) {
            return value.asDouble();
        }
        try {
            return value.isValueNode() ? Double.parseDouble(value.asText()) : null;
        } catch (Exception ex) {
            return null;
        }
    }

    /**
     * 判定条目类型（spec §4.1.9）。
     *
     * <p>模型给了 {@code kind} 就用它：通知里「假期 9/25–9/27」和「登记截止 9/24」是两类东西，
     * 而**截止日期同样是个时间**，靠「有没有时间」去猜会把待办判成日程。
     * 模型没给 kind 时才退回按有没有开始时间来判。
     */
    private static String parseKind(String raw, JsonNode startAtNode) {
        String value = raw == null ? "" : raw.trim().toUpperCase();
        if (value.contains("TASK") || value.contains("待办")) {
            return "TASK";
        }
        if (value.contains("EVENT") || value.contains("日程")) {
            return "EVENT";
        }
        boolean hasStart = startAtNode != null && !startAtNode.asText("").isBlank();
        return hasStart ? "EVENT" : "TASK";
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    /** 标记「模型没给出可解析的 JSON」，带上原文供修复重试使用。 */
    private static final class NotJson extends RuntimeException {
        private final String rawReply;

        private NotJson(String rawReply, String message) {
            super(message);
            this.rawReply = rawReply;
        }

        private String rawReply() {
            return rawReply;
        }
    }
}
