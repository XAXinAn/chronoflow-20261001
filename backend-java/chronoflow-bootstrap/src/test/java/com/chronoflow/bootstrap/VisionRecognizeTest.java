package com.chronoflow.bootstrap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.chronoflow.personal.ai.LocalVisionEventRecognizer;
import com.chronoflow.personal.ai.VisionProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 本地多模态识别（spec §4.1.9）。
 *
 * <p>不用真实模型：**模型本身不是要测的东西**，要测的是我们这一侧——
 * 提示词有没有把「一图多活动」「看不清时间就留空」交代清楚、回复里的代码块与
 * 半结构化的时间能不能解析、未配置时会不会老实报错。
 * 所以这里用 JDK 自带的 HttpServer 起一个假的 OpenAI 兼容端点。
 */
class VisionRecognizeTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("一张图识别出多条日程；相对时间按给定日期与时区换算")
    void parsesMultipleEventsFromOneImage() throws Exception {
        String reply = """
                ```json
                {"events":[
                  {"title":"季度技术评审会","at":"2026-09-26T15:00:00+08:00","location":"A座3F报告厅","confidence":0.92},
                  {"title":"团队晚餐","at":"2026-09-26 19:00"},
                  {"title":"季度总结","at":"2026-09-30"}
                ]}
                ```
                """;
        List<String> receivedPrompts = new ArrayList<>();
        startFakeModel(reply, receivedPrompts);

        var recognizer = new LocalVisionEventRecognizer(properties(), objectMapper);
        var events = recognizer.recognize(new byte[]{1, 2, 3}, "image/png", "2026-09-25", "Asia/Shanghai");

        assertThat(events).hasSize(3);
        assertThat(events.get(0).title()).isEqualTo("季度技术评审会");
        assertThat(events.get(0).at().toString()).isEqualTo("2026-09-26T15:00+08:00");
        assertThat(events.get(0).confidence()).isEqualTo(0.92);
        // 「2026-09-26 19:00」这种没有偏移量的写法，要按请求时区补上
        assertThat(events.get(1).at().toString()).isEqualTo("2026-09-26T19:00+08:00");
                // 只给日期 = 当天 00:00（「就这一天」）
        assertThat(events.get(2).at().toString()).isEqualTo("2026-09-30T00:00+08:00");

        // 提示词必须把「一图多活动」与「看不清时间不要猜」写进去，否则模型会擅自合并/编造
        assertThat(receivedPrompts).hasSize(1);
        assertThat(receivedPrompts.get(0)).contains("全部列出").contains("不要猜");
    }

    @Test
    @DisplayName("模型没给时间时不丢这条，交给 App 降级成待办")
    void keepsEventWithoutTime() throws Exception {
        startFakeModel("{\"events\":[{\"title\":\"看板上的事项\",\"at\":\"\",\"location\":\"\"}]}", new ArrayList<>());

        var events = new LocalVisionEventRecognizer(properties(), objectMapper)
                .recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai");

        assertThat(events).hasSize(1);
        assertThat(events.get(0).at()).isNull();
        assertThat(events.get(0).locationName()).isNull();
    }

    @Test
    @DisplayName("未配置模型时明确报 90002，不返回空列表冒充「图里没有日程」")
    void unconfiguredModelReportsUnavailable() {
        var properties = new VisionProperties();
        var recognizer = new LocalVisionEventRecognizer(properties, objectMapper);

        assertThat(recognizer.configured()).isFalse();
        assertThatThrownBy(() -> recognizer.recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai"))
                .hasMessageContaining("识别服务未配置");
    }

    @Test
    @DisplayName("模型第一次没给 JSON 时：把坏输出回灌让它修一次，第二次成功")
    void repairsWhenModelRepliesWithProse() throws Exception {
        List<String> prompts = new ArrayList<>();
        // 第一次回一段解释性文字（很常见），第二次才给 JSON
        startFakeModel(List.of(
                "好的，图片里是一场季度技术评审会，时间是 9 月 26 日下午三点。",
                "{\"events\":[{\"title\":\"季度技术评审会\",\"at\":\"2026-09-26T15:00:00+08:00\"}]}"
        ), prompts);

        var events = new LocalVisionEventRecognizer(properties(), objectMapper)
                .recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai");

        assertThat(events).hasSize(1);
        assertThat(events.get(0).title()).isEqualTo("季度技术评审会");
        // 第二次请求必须把坏输出原样带上，并明确要求「只输出 JSON」
        assertThat(prompts).hasSize(2);
        assertThat(prompts.get(1)).contains("上一次的输出不是合法 JSON")
                .contains("季度技术评审会，时间是");
    }

    @Test
    @DisplayName("模型一直不说 JSON：重试后明确报 90002，绝不把脏结果放进 App")
    void failsLoudlyWhenModelNeverReturnsJson() throws Exception {
        startFakeModel(List.of("抱歉，我看不清这张图。", "还是看不清。"), new ArrayList<>());

        var recognizer = new LocalVisionEventRecognizer(properties(), objectMapper);
        assertThatThrownBy(() -> recognizer.recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai"))
                .hasMessageContaining("不是合法 JSON");
    }

    @Test
    @DisplayName("校园通知（中秋放假 + 离返校登记）：一条跨天日程 + 两条待办，全部识别出来")
    void recognizesCampusNoticeFixture() throws Exception {
        // 这是用户给的真实测试图（学院通知）对应的模型回复：一图三类事，
        // 假期是跨天日程（只记起始那天）、登记与统计是带/不带截止的待办。
        String reply = """
                {"events":[
                  {"title":"中秋节假期","kind":"EVENT","at":"2026-09-25T00:00:00+08:00",
                   "description":"放假 3 天（9 月 25 日—9 月 27 日）","confidence":0.95},
                  {"title":"中秋节假期离返校登记","kind":"TASK","at":"2026-09-24T23:59:00+08:00",
                   "description":"钉钉→应用服务→学工系统→日常事务→节假日离返校→学生组；\\"离校不返家\\"需上传家长知情同意书，全体同学（含留校）均需填写"},
                  {"title":"填写 2026-2027 秋学期中秋节返校情况","kind":"TASK",
                   "description":"金山文档（信息工程学院）https://www.kdocs.cn/l/cpk2A3hrWyCd"}
                ]}
                """;
        startFakeModel(List.of(reply), new ArrayList<>());

        var items = new LocalVisionEventRecognizer(properties(), objectMapper)
                .recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai");

        assertThat(items).hasSize(3);

        // 假期：区间只记起始那一刻（当天 00:00 表示「就这一天」）
        var holiday = items.get(0);
        assertThat(holiday.kind()).isEqualTo("EVENT");
        assertThat(holiday.at().toString()).isEqualTo("2026-09-25T00:00+08:00");

        // 登记：待办 + 截止时间落在 at，而不是被当成一段日程
        var signUp = items.get(1);
        assertThat(signUp.kind()).isEqualTo("TASK");
        assertThat(signUp.at().toString()).isEqualTo("2026-09-24T23:59+08:00");
        assertThat(signUp.description()).contains("家长知情同意书");

        // 统计：没有截止时间也不该被丢掉，保持「待安排」
        var survey = items.get(2);
        assertThat(survey.kind()).isEqualTo("TASK");
        assertThat(survey.at()).isNull();
        // 链接放在描述里，不塞进标题
        assertThat(survey.title()).doesNotContain("http");
        assertThat(survey.description()).contains("kdocs.cn");
    }

    @Test
    @DisplayName("夹带解释、尾逗号、单引号、只回一个对象 —— 都能解析出来")
    void toleratesCommonlyMalformedJson() throws Exception {
        String messy = """
                好的，识别结果如下：
                ```json
                {
                  'events': [
                    {'title': '季度技术评审会', 'startAt': '2026-09-26T15:00:00+08:00',},
                  ],
                }
                ```
                需要我帮你创建吗？
                """;
        startFakeModel(List.of(messy), new ArrayList<>());

        var events = new LocalVisionEventRecognizer(properties(), objectMapper)
                .recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai");
        assertThat(events).hasSize(1);

        // 只回一个对象（没有 events 数组）也要认
        startFakeModel(List.of("{\"title\":\"团队晚餐\",\"at\":\"2026-09-26T19:00:00+08:00\"}"), new ArrayList<>());
        var single = new LocalVisionEventRecognizer(properties(), objectMapper)
                .recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai");
        assertThat(single).hasSize(1);
        assertThat(single.get(0).title()).isEqualTo("团队晚餐");
    }

    @Test
    @DisplayName("请求里带上结构化输出约束：默认 JSON 模式，可切到 JSON Schema")
    void sendsStructuredOutputConstraint() throws Exception {
        List<String> bodies = new ArrayList<>();
        startFakeModelRecordingRaw(List.of("{\"events\":[]}"), bodies);

        var properties = properties();
        new LocalVisionEventRecognizer(properties, objectMapper)
                .recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai");
        assertThat(objectMapper.readTree(bodies.get(0)).path("response_format").path("type").asText())
                .isEqualTo("json_object");

        properties.setStructuredOutput("json_schema");
        new LocalVisionEventRecognizer(properties, objectMapper)
                .recognize(new byte[]{1}, "image/png", "2026-09-25", "Asia/Shanghai");
        JsonNode strict = objectMapper.readTree(bodies.get(1)).path("response_format");
        assertThat(strict.path("type").asText()).isEqualTo("json_schema");
        assertThat(strict.path("json_schema").path("strict").asBoolean()).isTrue();
    }

    private VisionProperties properties() {
        var properties = new VisionProperties();
        properties.setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1");
        properties.setModel("qwen2.5vl:3b");
        return properties;
    }

    /** 起一个假的 OpenAI 兼容端点：收 /v1/chat/completions，回固定内容。 */
    private void startFakeModel(String replyContent, List<String> receivedPrompts) throws IOException {
        startFakeModel(List.of(replyContent), receivedPrompts);
    }

    /** 按顺序回一组回复（模拟「第一次不老实、第二次修好」）。 */
    private void startFakeModel(List<String> replies, List<String> receivedPrompts) throws IOException {
        List<String> rawBodies = new ArrayList<>();
        startFakeModelRecordingRaw(replies, receivedPrompts, rawBodies);
    }

    private void startFakeModelRecordingRaw(List<String> replies, List<String> rawBodies)
            throws IOException {
        startFakeModelRecordingRaw(replies, new ArrayList<>(), rawBodies);
    }

    private void startFakeModelRecordingRaw(List<String> replies, List<String> receivedPrompts,
                                            List<String> rawBodies) throws IOException {
        int[] callIndex = {0};
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", (HttpExchange exchange) -> {
            String requestBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            rawBodies.add(requestBody);
            receivedPrompts.add(objectMapper.readTree(requestBody)
                    .path("messages").path(0).path("content").path(0).path("text").asText(""));
            String replyContent = replies.get(Math.min(callIndex[0], replies.size() - 1));
            callIndex[0]++;
            var response = objectMapper.createObjectNode();
            response.putArray("choices").addObject().putObject("message").put("content", replyContent);
            byte[] body = objectMapper.writeValueAsBytes(response);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
    }
}
