package com.chronoflow.bootstrap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.agent.model.AgentMessage;
import com.chronoflow.agent.model.AgentModelClient;
import com.chronoflow.agent.model.AgentToolCall;
import com.chronoflow.agent.model.CompletionRequest;
import com.chronoflow.agent.model.CompletionResult;
import com.chronoflow.agent.model.ModelUsage;
import com.chronoflow.agent.model.TranscriptionResult;
import com.chronoflow.agent.service.AgentPrompt;
import com.chronoflow.agent.tool.AgentToolRegistry;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 小安的服务端链路（spec §11 阶段三）。
 *
 * <p>用脚本化的假模型替换真实上游：这里验证的是**我们这一侧**的行为——
 * 工具白名单、个人日程沙盒、读并行/遇写即停在用户授权前停下、提示词不变量、未配置时的降级。
 * 模型答得好不好不由单测管，那是提示词调优的事。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
class AgentModuleTest {

    /** 本类用过的测试手机号，防止两个用例复用同一个号（会撞 60 秒发码频控）。 */
    private static final Set<String> USED_PHONES = ConcurrentHashMap.newKeySet();

    /** 脚本化的假上游：按顺序吐出预设结果，并记录每次请求（用于断言"回灌给模型的是什么"）。 */
    static final class ScriptedAgentModelClient implements AgentModelClient {

        final AtomicBoolean available = new AtomicBoolean(true);
        /**
         * 线程安全：每轮对话都在虚拟线程上跑，而用例在主线程读这个列表。
         * 用 ArrayList 时偶发 ConcurrentModificationException（全量跑时踩到过）。
         */
        final List<CompletionRequest> requests = new CopyOnWriteArrayList<>();
        private final Deque<CompletionResult> script = new ArrayDeque<>();
        String lastTranscription = "";
        /** 转写被真正调到上游的次数：用来钉住「参数不对时不该打上游」。 */
        final AtomicInteger transcribeCalls = new AtomicInteger();

        void enqueue(String text, List<AgentToolCall> toolCalls) {
            script.add(new CompletionResult(text, List.copyOf(toolCalls),
                    toolCalls.isEmpty() ? "stop" : "tool_calls", new ModelUsage(100, 20)));
        }

        /**
         * 每个用例开始前清空脚本。
         *
         * <p>这个假模型是**单例 bean**，用例之间共享；某个用例多留一条预设（例如兜底追问那轮
         * 只用掉两条、还剩一条），下个用例就会消费到上一条 —— 表现为"串味"的失败
         * （断言里出现别的用例的文案），很难一眼看出来。
         */
        void reset() {
            script.clear();
            requests.clear();
            lastTranscription = "";
            transcribeCalls.set(0);
        }

        @Override
        public String providerName() {
            return available.get() ? "scripted" : "unconfigured";
        }

        @Override
        public boolean available() {
            return available.get();
        }

        @Override
        public boolean transcriptionAvailable() {
            return available.get();
        }

        @Override
        public CompletionResult complete(CompletionRequest request, Consumer<String> onTextDelta) {
            requests.add(request);
            CompletionResult next = script.poll();
            if (next == null) {
                throw new IllegalStateException("假模型的脚本用完了：这次请求没有预设结果");
            }
            if (next.text() != null && !next.text().isEmpty()) {
                onTextDelta.accept(next.text());
            }
            return next;
        }

        @Override
        public TranscriptionResult transcribe(byte[] audio, String contentType) {
            transcribeCalls.incrementAndGet();
            return new TranscriptionResult(lastTranscription, "zh");
        }
    }

    @TestConfiguration
    static class ScriptedConfig {

        @Bean
        @Primary
        ScriptedAgentModelClient scriptedAgentModelClient() {
            return new ScriptedAgentModelClient();
        }
    }

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;

    @Autowired
    private MockMvc mockMvc;

    /**
     * 对话请求走**真实端口**，不走 MockMvc。
     *
     * <p>SseEmitter 收尾时容器会对同一个请求再派发一次，而 MockMvc 的异步是"借"调用线程模拟的：
     * 一个用例里发多条 SSE 时，两个线程会同时写同一个 MockHttpServletResponse，
     * 偶发 ConcurrentModificationException / 空响应（实测：单跑看不出，全量跑随机红）。
     * 真端口下由 Tomcat 处理异步，没有这个问题（AgentStreamHttpTest 早就这么做了）。
     */
    @org.springframework.boot.test.web.server.LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ScriptedAgentModelClient model;

    @Autowired
    private AgentToolRegistry tools;

    @Autowired
    private AgentPrompt prompt;

    @Autowired
    private com.chronoflow.agent.permission.AgentApprovalRegistry approvals;

    /** 对话请求用的真实 HTTP 客户端（保持连接复用，避免每个用例都新建一堆 socket）。 */
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

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

    @BeforeEach
    void resetScriptedModel() {
        model.reset();
    }

    @Test
    @DisplayName("工具白名单：只有四个 my_ 前缀的工具，且都在个人日程范围内")
    void toolCatalogIsPersonalOnly() {
        List<String> names = tools.specs().stream().map(spec -> spec.name()).toList();

        assertThat(names).containsExactlyInAnyOrder(
                "list_my_events", "read_my_event_note",
                "create_my_event", "update_my_event", "delete_my_event");
        // 空闲时段改由模型自己看日程推算，不再是一个工具
        assertThat(names).doesNotContain("find_free_slots");
        // 组织日程将来以新工具加入，不会混进这几个
        assertThat(names).allMatch(name -> name.contains("my_event"));
        assertThat(tools.isReadOnly("list_my_events")).isTrue();
        assertThat(tools.isReadOnly("read_my_event_note")).as("读备注也是只读").isTrue();
        assertThat(tools.isReadOnly("create_my_event")).isFalse();
    }

    @Test
    @DisplayName("提示词来自 prompt.md：关键不变量齐、开发语气不留")
    void promptFileHoldsTheBehaviourSpec() {
        String rendered = prompt.render(java.util.Map.of(
                "today", "2026-09-28", "weekday", "周一", "now", "13:00",
                "timezone", "Asia/Shanghai", "org_line", "当前没有组织。",
                "action_results", "", "pending_actions", ""));

        assertThat(rendered).contains("2026-09-28").contains("Asia/Shanghai");
        assertThat(rendered).contains("list_my_events").contains("create_my_event")
                .contains("update_my_event").contains("delete_my_event");
        assertThat(rendered).contains("必须用户授权").contains("不说完成时").contains("只碰用户个人的日程");
        assertThat(rendered).contains("只有一个时间点");
        assertThat(rendered)
                .as("开发复盘语气不该出现在给模型看的正文里")
                .doesNotContain("实测踩过").doesNotContain("spec §").doesNotContain("TODO");
        assertThat(rendered).as("占位符必须全部替换掉").doesNotContain("{{");
        assertThat(prompt.version()).isNotBlank();
    }

    @Test
    @DisplayName("建日程：先申请授权（不落库），用户允许后由服务端真正写入并回灌工具结果")
    void createEventAsksForAuthorizationThenWritesAfterApproval() throws Exception {
        JsonNode account = registerAccount("13800000601", "小安用户");
        String token = account.path("data").path("accessToken").asText();
        long personalIdentityId = account.path("data").path("identity").path("identityId").asLong();

        model.enqueue("", List.of(new AgentToolCall("call_1", "create_my_event",
                "{\"title\":\"张总会\",\"at\":\"2026-09-28T15:00:00+08:00\","
                        + "\"locationName\":\"会议室A\"}")));
        model.enqueue("已经安排好了：9/28 15:00 张总会。", List.of());
        model.requests.clear();

        java.util.concurrent.CompletableFuture<String> stream = chatAsync(token,
                "{\"messages\":[{\"role\":\"user\",\"content\":\"明天下午三点和张总开会\"}]}");
        String actionId = awaitPendingApproval(stream);

        // 还没点允许：一条都不该落库
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM event WHERE creator_identity_id = ? AND deleted_at IS NULL",
                Integer.class, personalIdentityId))
                .as("授权之前不能写库").isZero();

        approve(token, actionId, true, null);
        String body = stream.get(30, java.util.concurrent.TimeUnit.SECONDS);

        assertThat(body).contains("event:action").contains("创建日程：").contains("event:tool");
        assertThat(jdbcTemplate.queryForObject(
                "SELECT title FROM event WHERE creator_identity_id = ? AND deleted_at IS NULL",
                String.class, personalIdentityId)).isEqualTo("张总会");
        // 工具结果要写回上下文，模型下一轮才看得到真实 eventId
        assertThat(firstToolResult(model.requests.get(1))).contains("张总会");
    }
    @Test
    @DisplayName("用户拒绝：写一条「什么都没改」的工具结果，不落库，也不许模型再申请一次")
    void deniedAuthorizationIsReportedBack() throws Exception {
        JsonNode account = registerAccount("13800000602", "拒绝用户");
        String token = account.path("data").path("accessToken").asText();
        long personalIdentityId = account.path("data").path("identity").path("identityId").asLong();

        model.enqueue("", List.of(new AgentToolCall("call_1", "create_my_event",
                "{\"title\":\"动员大会\",\"at\":\"2026-09-28T15:00:00+08:00\"}")));
        model.enqueue("好的，那不建了。", List.of());
        model.requests.clear();

        java.util.concurrent.CompletableFuture<String> stream = chatAsync(token,
                "{\"messages\":[{\"role\":\"user\",\"content\":\"明天三点开个动员大会\"}]}");
        String actionId = awaitPendingApproval(stream);
        approve(token, actionId, false, "算了，先不建");

        String body = stream.get(30, java.util.concurrent.TimeUnit.SECONDS);
        assertThat(body).contains("已拒绝");
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM event WHERE creator_identity_id = ?", Integer.class,
                personalIdentityId)).as("拒绝之后一条都不能建").isZero();
        String toolResult = firstToolResult(model.requests.get(1));
        assertThat(toolResult).contains("用户拒绝了").contains("什么都没有改动");
    }
    @Test
    @DisplayName("一轮里的工具调用按顺序执行：读 → 写（等授权）→ 读，三个都走到")
    void executesEveryToolCallInOrder() throws Exception {
        JsonNode account = registerAccount("13800000603", "读读写用户");
        String token = account.path("data").path("accessToken").asText();
        String range = "\"from\":\"2026-10-09T00:00:00+08:00\",\"to\":\"2026-10-10T00:00:00+08:00\"";
        model.enqueue("", List.of(
                new AgentToolCall("c1", "list_my_events", "{" + range + "}"),
                new AgentToolCall("c2", "create_my_event",
                        "{\"title\":\"临时会\",\"at\":\"2026-10-09T15:00:00+08:00\"}"),
                new AgentToolCall("c3", "list_my_events", "{" + range + "}")));
        model.enqueue("已经安排好了。", List.of());
        model.requests.clear();

        java.util.concurrent.CompletableFuture<String> stream = chatAsync(token,
                "{\"messages\":[{\"role\":\"user\",\"content\":\"下周五有什么，顺便加一场会\"}]}");
        String actionId = awaitPendingApproval(stream);
        approve(token, actionId, true, null);
        String body = stream.get(30, java.util.concurrent.TimeUnit.SECONDS);

        assertThat(body).contains("已查日程").contains("已创建日程");
        assertThat(countOccurrences(body, "已查日程")).as("写后面的那次读也要执行").isEqualTo(2);
    }
    @Test
    @DisplayName("查日程：时间窗口必填，结果按时间正序，个人日程带 id/标题/时间")
    void listRequiresTimeRangeAndSortsAscending() throws Exception {
        JsonNode account = registerAccount("13800000604", "查日程用户");
        String token = account.path("data").path("accessToken").asText();
        postJsonWithBearer("/api/v1/events", token,
                "{\"title\":\"晚一点的会\",\"at\":\"2026-10-12T09:00:00Z\""
                        + "}");
        postJsonWithBearer("/api/v1/events", token,
                "{\"title\":\"早一点的会\",\"at\":\"2026-10-12T01:00:00Z\""
                        + "}");

        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events",
                "{\"from\":\"2026-10-12T00:00:00+08:00\",\"to\":\"2026-10-13T00:00:00+08:00\"}")));
        model.enqueue("那天有两场会，分别是 09:00 和 17:00。", List.of());
        model.requests.clear();

        String stream = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"10 月 12 号有什么\"}]}");

        assertThat(stream).contains("event:tool").contains("已查日程 · 2 条");
        String toolResult = firstToolResult(model.requests.get(1));
        JsonNode payload = objectMapper.readTree(toolResult);
        assertThat(payload.path("total").asInt()).isEqualTo(2);
        assertThat(payload.path("events").get(0).path("title").asText())
                .as("正序：早的在前").isEqualTo("早一点的会");
        assertThat(payload.path("events").get(1).path("title").asText()).isEqualTo("晚一点的会");
    }

    @Test
    @DisplayName("时间范围缺失：工具直接报错，不出授权也不编")
    void listWithoutTimeRangeFails() throws Exception {
        JsonNode account = registerAccount("13800000605", "缺时间用户");
        String token = account.path("data").path("accessToken").asText();

        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events", "{\"keyword\":\"评审\"}")));
        model.enqueue("要看哪一段时间？", List.of());

        String stream = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"找一下评审会\"}]}");

        assertThat(stream).contains("这次没成").contains("from 与 to");
        assertThat(stream).doesNotContain("event:action");
    }

    @Test
    @DisplayName("缺时间：工具拒绝并让模型先问，绝不自己编一个时间")
    void createWithoutTimeIsRefused() throws Exception {
        JsonNode account = registerAccount("13800000621", "缺时间用户");
        String token = account.path("data").path("accessToken").asText();

        model.enqueue("", List.of(new AgentToolCall("call_1", "create_my_event",
                "{\"title\":\"和张总开会\"}")));
        model.enqueue("这场会安排在哪天几点？", List.of());
        model.requests.clear();

        String stream = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"和张总开个会\"}]}");

        assertThat(stream).contains("这次没成").contains("还缺日程标题或时间");
        assertThat(stream).doesNotContain("event:action");
    }

    @Test
    @DisplayName("工具报错统一形状：只回 {\"error\":…} 给模型，不出授权（与 list 一致）")
    void toolErrorsShareTheSameShapeAsList() throws Exception {
        JsonNode account = registerAccount("13800000610", "报错形状用户");
        String token = account.path("data").path("accessToken").asText();

        // ① list 的参数错误
        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events", "{}")));
        model.enqueue("要看哪一段时间？", List.of());
        model.requests.clear();
        String listing = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"我有什么\"}]}");
        JsonNode listError = objectMapper.readTree(firstToolResult(model.requests.get(1)));

        // ② 写操作的目标不存在 —— 形状必须一样
        model.enqueue("", List.of(new AgentToolCall("c2", "delete_my_event",
                "{\"eventId\":999999}")));
        model.enqueue("找不到这条日程。", List.of());
        model.requests.clear();
        String deleting = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"把 999999 删了\"}]}");
        JsonNode deleteError = objectMapper.readTree(firstToolResult(model.requests.get(1)));

        List<String> listFields = new ArrayList<>();
        listError.fieldNames().forEachRemaining(listFields::add);
        List<String> deleteFields = new ArrayList<>();
        deleteError.fieldNames().forEachRemaining(deleteFields::add);
        assertThat(listFields).containsExactly("error");
        assertThat(deleteFields).containsExactly("error");
        assertThat(listing).contains("这次没成");
        assertThat(deleting).contains("这次没成").doesNotContain("event:action");
    }

    @Test
    @DisplayName("超过 20 条只回「太多」：不给数据，让模型缩小范围再查")
    void tooManyEventsReturnsHintInsteadOfData() throws Exception {
        JsonNode account = registerAccount("13800000606", "日程很多用户");
        String token = account.path("data").path("accessToken").asText();
        for (int i = 0; i < 21; i++) {
            postJsonWithBearer("/api/v1/events", token,
                    "{\"title\":\"会 " + i + "\",\"at\":\"2026-10-20T0" + (i % 9) + ":00:00+08:00\","
                            + "\"at\":\"2026-10-20T0" + (i % 9) + ":30:00+08:00\"}");
        }

        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events",
                "{\"from\":\"2026-10-20T00:00:00+08:00\",\"to\":\"2026-10-21T00:00:00+08:00\"}")));
        model.enqueue("那一天安排太多了，先看上午还是下午？", List.of());
        model.requests.clear();

        String stream = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"10 月 20 号有什么\"}]}");

        assertThat(stream).contains("event:tool").contains("日程较多");
        JsonNode payload = objectMapper.readTree(firstToolResult(model.requests.get(1)));
        assertThat(payload.path("tooMany").asBoolean()).isTrue();
        assertThat(payload.path("total").asInt()).isGreaterThan(20);
        assertThat(payload.has("events")).as("超限时不给数据").isFalse();
        assertThat(payload.path("hint").asText()).contains("缩小时间范围");
    }

    @Test
    @DisplayName("隔离沙盒：看不到、也改不动别人的日程（一律当「找不到」）")
    void cannotTouchAnotherUsersEvent() throws Exception {
        JsonNode owner = registerAccount("13800000607", "日程主人");
        String ownerToken = owner.path("data").path("accessToken").asText();
        JsonNode others = postJsonWithBearer("/api/v1/events", ownerToken,
                "{\"title\":\"主人的会\",\"at\":\"2026-11-02T01:00:00Z\""
                        + "}");
        long otherEventId = others.path("data").path("id").asLong();

        JsonNode intruder = registerAccount("13800000608", "别人");
        String intruderToken = intruder.path("data").path("accessToken").asText();

        // ① 查不到：同一时间范围内只有自己的日程
        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events",
                "{\"from\":\"2026-11-02T00:00:00+08:00\",\"to\":\"2026-11-03T00:00:00+08:00\"}")));
        model.enqueue("那天你没有安排。", List.of());
        model.requests.clear();
        String listing = chat(intruderToken, "{\"messages\":[{\"role\":\"user\",\"content\":\"11 月 2 号我有什么\"}]}");
        assertThat(listing).contains("已查日程 · 没有安排").doesNotContain("主人的会");

        // ② 改不动：用别人的 eventId 申请修改 → 找不到，且没有授权行
        model.enqueue("", List.of(new AgentToolCall("c2", "update_my_event",
                "{\"eventId\":" + otherEventId + ",\"title\":\"改成我的\"}")));
        model.enqueue("找不到这条日程。", List.of());
        model.requests.clear();
        String updating = chat(intruderToken, "{\"messages\":[{\"role\":\"user\",\"content\":\"把那条改个名\"}]}");
        assertThat(updating).contains("这次没成").contains("找不到这条日程");
        assertThat(updating).doesNotContain("event:action");

        // ③ 删不掉
        model.enqueue("", List.of(new AgentToolCall("c3", "delete_my_event",
                "{\"eventId\":" + otherEventId + "}")));
        model.enqueue("找不到这条日程。", List.of());
        model.requests.clear();
        String deleting = chat(intruderToken, "{\"messages\":[{\"role\":\"user\",\"content\":\"把那条删了\"}]}");
        assertThat(deleting).contains("这次没成").doesNotContain("event:action");

        // 主人的日程原样还在
        assertThat(jdbcTemplate.queryForObject(
                "SELECT title FROM event WHERE id = ?", String.class, otherEventId))
                .isEqualTo("主人的会");
    }

    @Test
    @DisplayName("组织日程不在范围内：查不到、也改不了（下一阶段才做组织工具）")
    void orgEventsAreOutOfScopeForPersonalTools() throws Exception {
        JsonNode account = registerAccount("13800000609", "组织成员");
        String token = account.path("data").path("accessToken").asText();
        long orgId = seedOrgWithOwnerMember("AGENTORG609", "A6009");
        JsonNode claim = postJsonWithBearer("/api/v1/org-accounts/login?deviceId=device-1", token,
                "{\"org\":\"AGENTORG609\",\"memberKey\":\"A6009\"}");
        String orgToken = claim.path("data").path("accessToken").asText();
        long memberId = jdbcTemplate.queryForObject(
                "SELECT id FROM org_member WHERE org_id = ?", Long.class, orgId);
        JsonNode dispatched = postJsonWithBearer("/api/v1/org-admin/events", orgToken,
                "{\"title\":\"季度大会\",\"at\":\"2026-12-11T01:00:00Z\","
                        + "\"scopeType\":\"MEMBER\","
                        + "\"memberIds\":[" + memberId + "],\"includeSubDepartments\":false}");
        long orgEventId = dispatched.path("data").path("eventId").asLong();

        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events",
                "{\"from\":\"2026-12-11T00:00:00+08:00\",\"to\":\"2026-12-12T00:00:00+08:00\"}")));
        model.enqueue("那天你没有个人日程。", List.of());
        model.requests.clear();
        String listing = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"12 月 11 号我有什么\"}]}");
        assertThat(listing).contains("已查日程 · 没有安排").doesNotContain("季度大会");

        model.enqueue("", List.of(new AgentToolCall("c2", "delete_my_event",
                "{\"eventId\":" + orgEventId + "}")));
        model.enqueue("这条不在你的个人日程里。", List.of());
        model.requests.clear();
        String deleting = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"把季度大会删了\"}]}");
        assertThat(deleting).contains("这次没成").doesNotContain("event:action");
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM event WHERE id = ? AND deleted_at IS NULL", Integer.class,
                orgEventId)).isEqualTo(1);
    }

    @Test
    @DisplayName("备注：列表只给定长预览；全文用 read_my_event_note 分段读（单次封顶）")
    void notePreviewAndPagedNoteReading() throws Exception {
        JsonNode account = registerAccount("13800000611", "备注用户");
        String token = account.path("data").path("accessToken").asText();
        // 一定要比单次读上限（500）长，否则"夹到上限"这件事根本测不出来
        String longNote = "会前准备：".repeat(200) + "结束";
        JsonNode created = postJsonWithBearer("/api/v1/events", token,
                "{\"title\":\"长备注的会\",\"at\":\"2026-10-15T06:00:00Z\","
                        + "\"description\":\"" + longNote + "\"}");
        long eventId = created.path("data").path("id").asLong();

        // ① 列表：只给 60 字预览 + 总长度
        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events",
                "{\"from\":\"2026-10-15T00:00:00+08:00\",\"to\":\"2026-10-16T00:00:00+08:00\"}")));
        model.enqueue("那天有一场会，备注有点长。", List.of());
        model.requests.clear();
        chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"10 月 15 号有什么\"}]}");
        JsonNode listed = objectMapper.readTree(firstToolResult(model.requests.get(1)))
                .path("events").get(0);
        assertThat(listed.path("notePreview").asText().length())
                .as("预览固定 60 字 + 省略号").isLessThanOrEqualTo(61);
        assertThat(listed.path("noteLength").asInt()).isEqualTo(longNote.length());
        assertThat(listed.path("notePreview").asText()).doesNotContain("结束");

        // ② 分段读：要 1000 字也只给 500，并告诉模型还有更多
        model.enqueue("", List.of(new AgentToolCall("c2", "read_my_event_note",
                "{\"eventId\":" + eventId + ",\"offset\":0,\"length\":1000}")));
        model.enqueue("备注前半段是准备事项。", List.of());
        model.requests.clear();
        String reading = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"第一条的备注写了什么\"}]}");
        JsonNode note = objectMapper.readTree(firstToolResult(model.requests.get(1)));
        assertThat(note.path("length").asInt()).as("单次封顶 500 字").isEqualTo(500);
        assertThat(note.path("maxLength").asInt()).isEqualTo(500);
        assertThat(note.path("total").asInt()).isEqualTo(longNote.length());
        assertThat(note.path("hasMore").asBoolean()).isTrue();
        assertThat(note.path("text").asText()).hasSize(500);
        assertThat(reading).contains("已读备注").doesNotContain("event:action");

        // ③ 没有 offset/length 直接报错（和 list 一样只回给模型）
        model.enqueue("", List.of(new AgentToolCall("c3", "read_my_event_note",
                "{\"eventId\":" + eventId + "}")));
        model.enqueue("要读哪一段？", List.of());
        model.requests.clear();
        String bad = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"读一下备注\"}]}");
        assertThat(bad).contains("这次没成");
        assertThat(objectMapper.readTree(firstToolResult(model.requests.get(1))).has("error")).isTrue();
    }

    @Test
    @DisplayName("地点分两层：真地名解析成带坐标的地点，地图上没有的（会议室A）进详细地址")
    void locationIsSplitIntoPlaceAndDetail() throws Exception {
        JsonNode account = registerAccount("13800000613", "地点用户");
        String token = account.path("data").path("accessToken").asText();

        model.enqueue("", List.of(new AgentToolCall("c1", "create_my_event",
                "{\"title\":\"评审\",\"at\":\"2026-09-28T15:00:00+08:00\","
                        + "\"locationName\":\"会议室A\"}")));
        model.enqueue("好的，不建了。", List.of());
        model.requests.clear();

        java.util.concurrent.CompletableFuture<String> stream = chatAsync(token,
                "{\"messages\":[{\"role\":\"user\",\"content\":\"明天下午三点在会议室A评审\"}]}");
        String actionId = awaitPendingApproval(stream);
        approve(token, actionId, false, null);
        String body = stream.get(30, java.util.concurrent.TimeUnit.SECONDS);

        JsonNode payload = actionPayload(body);
        assertThat(payload.path("title").asText()).isEqualTo("评审");
        assertThat(payload.has("locationName")).as("「会议室A」不是地图上的地点").isFalse();
        assertThat(payload.path("locationDetail").asText()).isEqualTo("会议室A");
    }
    @Test
    @DisplayName("模型只说「确认一下」却没调工具时，服务端追问一轮把工具调出来")
    void nudgesModelWhenItSkipsTheTool() throws Exception {
        JsonNode account = registerAccount("13800000614", "兜底用户");
        String token = account.path("data").path("accessToken").asText();

        model.enqueue("要把「动员大会」的时间改到 17:00，确认一下。", List.of());
        model.enqueue("", List.of(new AgentToolCall("call_1", "create_my_event",
                "{\"title\":\"动员大会\",\"at\":\"2026-09-29T13:00:00+08:00\"}")));
        model.enqueue("好的，那不建了。", List.of());
        model.requests.clear();

        java.util.concurrent.CompletableFuture<String> stream = chatAsync(token,
                "{\"messages\":[{\"role\":\"user\",\"content\":\"把动员大会改到下午5点\"}]}");
        String actionId = awaitPendingApproval(stream);
        approve(token, actionId, false, null);
        String body = stream.get(30, java.util.concurrent.TimeUnit.SECONDS);

        assertThat(body).as("追问后应该真的出授权行").contains("event:action");
        String nudged = model.requests.get(1).messages().stream()
                .filter(message -> AgentMessage.ROLE_SYSTEM.equals(message.role()))
                .map(AgentMessage::content)
                .toList().toString();
        assertThat(nudged).contains("不要用一句「确认一下？」代替授权请求");
    }
    @Test
    @DisplayName("先查到、却只回「确认一下？」：追问一轮把它推到申请授权（线上实测的坑）")
    void nudgesAfterReadInsteadOfAskingInProse() throws Exception {
        JsonNode account = registerAccount("13800000622", "删日程用户");
        String token = account.path("data").path("accessToken").asText();
        JsonNode created = postJsonWithBearer("/api/v1/events", token,
                "{\"title\":\"和张总开会\",\"at\":\"2026-09-29T15:00:00+08:00\"}");
        long eventId = created.path("data").path("id").asLong();

        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events",
                "{\"from\":\"2026-09-29T00:00:00+08:00\",\"to\":\"2026-09-30T00:00:00+08:00\"}")));
        model.enqueue("要把明天 15:00 和张总开会的那条日程删掉，确认一下？", List.of());
        model.enqueue("", List.of(new AgentToolCall("c2", "delete_my_event",
                "{\"eventId\":" + eventId + "}")));
        model.enqueue("好的，那先留着。", List.of());
        model.requests.clear();

        java.util.concurrent.CompletableFuture<String> stream = chatAsync(token,
                "{\"messages\":[{\"role\":\"user\",\"content\":\"把明天和张总的那个会删掉\"}]}");
        String actionId = awaitPendingApproval(stream);
        approve(token, actionId, false, null);
        String body = stream.get(30, java.util.concurrent.TimeUnit.SECONDS);

        assertThat(body).contains("event:action").contains("已拒绝");
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM event WHERE id = ? AND deleted_at IS NULL", Integer.class, eventId))
                .as("拒绝之后不能真删").isEqualTo(1);
    }
    @Test
    @DisplayName("查完之后的纯查询不追问：不能把「我明天有什么安排」推成写操作")
    void readThenQueryIsNotNudged() throws Exception {
        JsonNode account = registerAccount("13800000623", "查询用户");
        String token = account.path("data").path("accessToken").asText();

        model.enqueue("", List.of(new AgentToolCall("c1", "list_my_events",
                "{\"from\":\"2026-09-29T00:00:00+08:00\",\"to\":\"2026-09-30T00:00:00+08:00\"}")));
        model.enqueue("明天有一场会。", List.of());
        model.requests.clear();

        String stream = chat(token,
                "{\"messages\":[{\"role\":\"user\",\"content\":\"我明天有什么安排\"}]}");

        assertThat(stream).doesNotContain("event:action");
        assertThat(model.requests).as("没有追问：请求次数就是轮数").hasSize(2);
    }

    @Test
    @DisplayName("客户端带回的工具调用与结果原样进上下文；缺结果的补一条 interrupted（ToolPairing）")
    void replaysClientSideToolPairs() throws Exception {
        JsonNode account = registerAccount("13800000624", "配对用户");
        String token = account.path("data").path("accessToken").asText();

        model.enqueue("已经安排好了。", List.of());
        model.requests.clear();

        chat(token, "{\"messages\":["
                + "{\"role\":\"user\",\"content\":\"明天下午三点和张总开会\"},"
                + "{\"role\":\"assistant\",\"content\":\"要把明天 15:00 的会和张总开上。\","
                + "\"toolCalls\":[{\"id\":\"call_1\",\"name\":\"create_my_event\","
                + "\"arguments\":\"{\\\"title\\\":\\\"和张总开会\\\"}\"}]},"
                + "{\"role\":\"tool\",\"toolCallId\":\"call_1\","
                + "\"content\":\"{\\\"status\\\":\\\"ok\\\",\\\"eventId\\\":77}\"},"
                + "{\"role\":\"assistant\",\"content\":\"那我再查一下天。\","
                + "\"toolCalls\":[{\"id\":\"call_2\",\"name\":\"list_my_events\","
                + "\"arguments\":\"{}\"}]}"
                + "]}");

        java.util.List<AgentMessage> sent = model.requests.get(0).messages();
        AgentMessage withCall = sent.stream()
                .filter(m -> !m.toolCalls().isEmpty() && "call_1".equals(m.toolCalls().get(0).id()))
                .findFirst().orElseThrow();
        assertThat(withCall.role()).isEqualTo(AgentMessage.ROLE_ASSISTANT);
        assertThat(withCall.content()).contains("要把明天 15:00");
        assertThat(sent.stream().map(AgentMessage::toolCallId).toList()).contains("call_1");
        assertThat(sent.stream().filter(m -> "call_2".equals(m.toolCallId())).findFirst()
                .orElseThrow().content()).contains("interrupted");
    }
    @Test
    @DisplayName("授权动作 id 全局唯一：跨轮重号会让「拒绝」点不动（客户端按 id 认卡片）")
    void actionIdsAreUniqueAcrossRounds() throws Exception {
        JsonNode account = registerAccount("13800000626", "重号用户");
        String token = account.path("data").path("accessToken").asText();
        String body = "{\"messages\":[{\"role\":\"user\",\"content\":\"明天下午三点和张总开会\"}]}";
        String call = "{\"title\":\"和张总开会\",\"at\":\"2026-09-30T15:00:00+08:00\"}";

        model.enqueue("", List.of(new AgentToolCall("c1", "create_my_event", call)));
        model.enqueue("好，不建了。", List.of());
        java.util.concurrent.CompletableFuture<String> first = chatAsync(token, body);
        String firstId = awaitPendingApproval(first);
        approve(token, firstId, false, null);
        first.get(30, java.util.concurrent.TimeUnit.SECONDS);

        model.enqueue("", List.of(new AgentToolCall("c2", "create_my_event", call)));
        model.enqueue("好，不建了。", List.of());
        java.util.concurrent.CompletableFuture<String> second = chatAsync(token, body);
        String secondId = awaitPendingApproval(second);
        approve(token, secondId, false, null);
        second.get(30, java.util.concurrent.TimeUnit.SECONDS);

        assertThat(firstId).isNotBlank();
        assertThat(secondId).as("两轮授权 id 不能重复（原来每轮都从 a1 开始）").isNotEqualTo(firstId);
    }
    @Test
    @DisplayName("纯聊天不追问：用户只是打个招呼，不要硬塞工具调用")
    void pureChatIsNotNudged() throws Exception {
        JsonNode account = registerAccount("13800000615", "聊天用户");
        String token = account.path("data").path("accessToken").asText();

        model.enqueue("你好呀，我是小安。", List.of());
        model.requests.clear();

        String stream = chat(token, "{\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}");

        assertThat(stream).doesNotContain("event:action").doesNotContain("event:tool");
        assertThat(model.requests).as("纯聊天只该问模型一次").hasSize(1);
    }

    @Test
    @DisplayName("没有动词但明显要建日程（「明天下午三点和张总开会」）也要触发兜底追问")
    void nudgesOnTimePhraseWithoutVerb() throws Exception {
        JsonNode account = registerAccount("13800000620", "时间词用户");
        String token = account.path("data").path("accessToken").asText();

        // 第 1 轮：模型只回"我打算这样安排"的文字（实测踩过：用户没有任何可点的授权行）
        model.enqueue("要把明天的会议安排如下：标题「和张总开会」，时间 2026-09-29 15:00-16:00。", List.of());
        model.enqueue("", List.of(new AgentToolCall("call_1", "create_my_event",
                "{\"title\":\"和张总开会\",\"at\":\"2026-09-29T15:00:00+08:00\"}")));
        model.enqueue("好的，那不建了。", List.of());
        model.requests.clear();

        java.util.concurrent.CompletableFuture<String> stream = chatAsync(token,
                "{\"messages\":[{\"role\":\"user\",\"content\":\"明天下午三点和张总开一小时会\"}]}");
        String actionId = awaitPendingApproval(stream);
        approve(token, actionId, false, null);
        String body = stream.get(30, java.util.concurrent.TimeUnit.SECONDS);

        assertThat(body).contains("event:action");
        // 第 1 次是"只回文字"，第 2 次是被追问后真的调工具，第 3 次是拒绝之后收尾
        assertThat(model.requests).as("追问确实多问了一轮").hasSize(3);
        assertThat(allMessageText(model.requests.get(1))).contains("不要用一句「确认一下？」代替授权请求");
    }

    @Test
    @DisplayName("流式响应头：不许缓存、不许反代缓冲")
    void streamResponseHeadersDisableBuffering() throws Exception {
        JsonNode account = registerAccount("13800000616", "响应头用户");
        String token = account.path("data").path("accessToken").asText();
        model.enqueue("在的。", List.of());

        HttpRequest request = HttpRequest.newBuilder(chatUri())
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(
                        "{\"messages\":[{\"role\":\"user\",\"content\":\"在吗\"}]}"))
                .build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("cache-control").orElse("")).isEqualTo("no-cache");
        assertThat(response.headers().firstValue("x-accel-buffering").orElse("")).isEqualTo("no");
        assertThat(response.headers().firstValue("content-type").orElse(""))
                .contains("text/event-stream");
        assertThat(response.body()).contains("event:done");
    }

    @Test
    @DisplayName("orgIdentityId 越权：不是自己的组织身份一律拒绝")
    void foreignOrgIdentityIsRejected() throws Exception {
        JsonNode account = registerAccount("13800000617", "越权用户");
        String token = account.path("data").path("accessToken").asText();
        long personalIdentityId = account.path("data").path("identity").path("identityId").asLong();

        mockMvc.perform(post("/api/v1/ai/agent/chat")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"messages\":[{\"role\":\"user\",\"content\":\"在吗\"}],"
                                + "\"orgIdentityId\":" + personalIdentityId + "}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));

        mockMvc.perform(post("/api/v1/ai/agent/chat")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"messages\":[{\"role\":\"user\",\"content\":\"在吗\"}],"
                                + "\"orgIdentityId\":999999}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));
    }

    @Test
    @DisplayName("模型未配置时不开流，直接回 90002；/system/info 如实上报 aiAgentEnabled")
    void unconfiguredModelReportsUnavailable() throws Exception {
        JsonNode account = registerAccount("13800000618", "未接入用户");
        String token = account.path("data").path("accessToken").asText();

        assertThat(publicJson("/api/v1/system/info").path("data").path("aiAgentEnabled").asBoolean())
                .isTrue();

        model.available.set(false);
        try {
            mockMvc.perform(post("/api/v1/ai/agent/chat")
                            .header("Authorization", "Bearer " + token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .accept(MediaType.TEXT_EVENT_STREAM, MediaType.APPLICATION_JSON)
                            .content("{\"messages\":[{\"role\":\"user\",\"content\":\"在吗\"}]}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.code").value(90002));
            assertThat(publicJson("/api/v1/system/info").path("data").path("aiAgentEnabled").asBoolean())
                    .isFalse();

            mockMvc.perform(multipart("/api/v1/ai/transcribe")
                            .file(new MockMultipartFile("file", "voice.m4a", "audio/mp4", new byte[]{1, 2, 3}))
                            .header("Authorization", "Bearer " + token))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.code").value(90002));

            // 图片识别日程的第二段（OCR 文字 → 草稿）：没配模型同样当场拒绝，不空跑
            mockMvc.perform(post("/api/v1/ai/events/parse-text")
                            .header("Authorization", "Bearer " + token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"text\":\"9 月 24 日前完成离返校登记\","
                                    + "\"today\":\"2026-09-30\",\"timezone\":\"Asia/Shanghai\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.code").value(90002));
        } finally {
            model.available.set(true);
        }
    }

    @Test
    @DisplayName("OCR 文字 → 日程草稿：只抽要做的事、缺日期照样返回、带 timezone 无 kind（spec §4.1.9）")
    void parsesOcrTextIntoDrafts() throws Exception {
        JsonNode account = registerAccount("13800000635", "识别用户");
        String token = account.path("data").path("accessToken").asText();

        // 模型爱包的 ```json 围栏 + 前后解释都要能吃下去（这条链路上最常见的脏输出）。
        // 第二条没写日期：这是**合法结果**，必须原样返回，不能丢掉。
        model.enqueue("""
                好的，识别结果如下：
                ```json
                {"items":[
                  {"title":"离返校登记","at":"2026-09-24T00:00:00+08:00",
                   "timezone":"Asia/Shanghai","description":"9 月 24 日前在学工系统完成离返校登记"},
                  {"title":"填写返校情况统计表","timezone":"Asia/Shanghai","description":"金山文档填写"}
                ]}
                ```
                """, List.of());

        JsonNode parsed = postJsonWithBearer("/api/v1/ai/events/parse-text", token,
                "{\"text\":\"一、假期安排与离返校登记\\n中秋假期：9月25日—9月27日（共3天）"
                        + "\\n登记截止：9月24日前\\n二、返校情况统计：请各班填写统计表\","
                        + "\"today\":\"2026-09-30\",\"timezone\":\"Asia/Shanghai\"}");

        JsonNode items = parsed.path("data").path("items");
        assertThat(items).as("一份通知要抽出多条: %s", parsed).hasSize(2);
        // 只产出日程：没有 kind / confidence 这些我们不再需要的字段
        assertThat(items.get(0).path("kind").isMissingNode()).as("不再有 kind").isTrue();
        assertThat(items.get(0).path("confidence").isMissingNode()).isTrue();
        assertThat(items.get(0).path("title").asText()).isEqualTo("离返校登记");
        // at 直接给原时区字符串（不再是 Jackson 归一后的 UTC），客户端一眼能看懂
        assertThat(OffsetDateTime.parse(items.get(0).path("at").asText()).toInstant())
                .as("2026-09-24T00:00+08:00")
                .isEqualTo(Instant.parse("2026-09-23T16:00:00Z"));
        assertThat(items.get(0).path("timezone").asText()).isEqualTo("Asia/Shanghai");
        // 没写日期的那条：at 缺失（non_null），但条目本身必须在
        assertThat(items.get(1).path("title").asText()).isEqualTo("填写返校情况统计表");
        assertThat(items.get(1).path("at").isMissingNode()).as("缺日期的条目照样返回").isTrue();

        // 提示词里必须带「今天」与「时区」，并把抽取口径钉住；占位符不能原样漏给模型
        CompletionRequest request = model.requests.get(model.requests.size() - 1);
        String prompt = firstMessageContent(request);
        assertThat(prompt).contains("2026-09-30").contains("Asia/Shanghai")
                .contains("要你做的事").contains("没写就留空")
                .contains("不要拿今天兜底").contains("不要猜时刻")
                .doesNotContain("{{");
        // 结构化输出 + 温度 0：抽取要的是稳定，不是想象力
        assertThat(request.jsonMode()).isTrue();
        assertThat(request.temperature()).isEqualTo(0.0);
    }

    @Test
    @DisplayName("语音输入：录音转成文字返回，音频不落盘")
    void transcriptionReturnsText() throws Exception {
        JsonNode account = registerAccount("13800000619", "语音用户");
        String token = account.path("data").path("accessToken").asText();
        model.lastTranscription = "说明天下午三点和张总开会";

        mockMvc.perform(multipart("/api/v1/ai/transcribe")
                        .file(new MockMultipartFile("file", "voice.m4a", "audio/mp4", new byte[]{1, 2, 3}))
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.text").value("说明天下午三点和张总开会"));
    }

    @Test
    @DisplayName("语音输入：超上限的音频与忘带文件都当场拒掉，不打上游")
    void transcriptionValidatesBeforeCallingUpstream() throws Exception {
        JsonNode account = registerAccount("13800000627", "语音校验用户");
        String token = account.path("data").path("accessToken").asText();
        model.transcribeCalls.set(0);

        // 直接卡在参数上（10002），不落到「未配置」上——反过来会把排查引偏
        byte[] tooBig = new byte[5 * 1024 * 1024 + 1];
        mockMvc.perform(multipart("/api/v1/ai/transcribe")
                        .file(new MockMultipartFile("file", "long.m4a", "audio/mp4", tooBig))
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(10002));

        mockMvc.perform(multipart("/api/v1/ai/transcribe")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(10001));

        assertThat(model.transcribeCalls.get()).as("参数就不对，不该打上游").isZero();
    }

    // ---------------------------------------------------------------- helpers

    /**
     * 发一次对话并等流结束。
     *
     * <p>必须显式把**异步派发**做掉：SSE 收尾时容器会对同一个请求再派发一次，
     * MockMvc 会把它推迟到下一次 perform，于是落到下一个用例的响应对象上，
     * 表现为偶发的 ConcurrentModificationException 或"这条流是空的"（全量跑时才会出现）。
     */
    private String chat(String token, String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(chatUri())
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        return http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();
    }

    /**
     * 把一次对话放到后台跑：新流程里写操作会**阻塞等用户点授权**，
     * 主线程要腾出来去调审批接口。
     */
    private java.util.concurrent.CompletableFuture<String> chatAsync(String token, String body) {
        return java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try {
                return chat(token, body);
            } catch (Exception ex) {
                throw new IllegalStateException(ex);
            }
        });
    }

    /** 等这次对话里出现待授权（服务端正在阻塞等用户答复）。 */
    private String awaitPendingApproval(java.util.concurrent.CompletableFuture<String> stream)
            throws Exception {
        for (int i = 0; i < 300; i++) {
            java.util.Set<String> pending = approvals.pendingActionIds();
            if (!pending.isEmpty()) {
                return pending.iterator().next();
            }
            if (stream.isDone()) {
                throw new AssertionError("流已经结束了，却没有出现待授权：" + stream.get());
            }
            Thread.sleep(50);
        }
        throw new AssertionError("等不到待授权");
    }

    /** 用户点「允许 / 拒绝」（mewcode 的 PermissionReply）。 */
    private void approve(String token, String actionId, boolean allow, String feedback)
            throws Exception {
        String body = "{\"actionId\":\"" + actionId + "\",\"allow\":" + allow
                + (feedback == null ? "" : ",\"feedback\":\"" + feedback + "\"") + "}";
        postJsonWithBearer("/api/v1/ai/agent/approvals", token, body);
    }

    private URI chatUri() {
        return URI.create("http://127.0.0.1:" + port + "/api/v1/ai/agent/chat");
    }

    /** 从 SSE 文本里把第一个授权动作的 payload 取出来。 */
    private JsonNode actionPayload(String stream) throws Exception {
        for (String line : stream.split("\n")) {
            if (line.startsWith("data:") && line.contains("\"actionId\"")) {
                return objectMapper.readTree(line.substring("data:".length()).trim()).path("payload");
            }
        }
        throw new AssertionError("这条流里没有授权请求：" + stream);
    }

    /** 从 SSE 文本里取第一个授权动作的 actionId。 */
    private String actionId(String stream) throws Exception {
        for (String line : stream.split("\n")) {
            if (line.startsWith("data:") && line.contains("\"actionId\"")) {
                return objectMapper.readTree(line.substring("data:".length()).trim())
                        .path("actionId").asText();
            }
        }
        throw new AssertionError("这条流里没有授权请求：" + stream);
    }

    private static String firstMessageContent(CompletionRequest request) {
        return request.messages().isEmpty() ? "" : request.messages().get(0).content();
    }

    /**
     * 用户那句话**之后**的所有上下文（授权结果 / 挂着的授权 / 兜底追问都在这里）。
     *
     * <p>不直接取"最后一条"：兜底追问会在授权结果之后再追加一条，
     * 那时最后一条是追问、而不是我们想断言的那段。
     */
    private static String contextAfterLastUser(CompletionRequest request) {
        List<AgentMessage> messages = request.messages();
        int lastUser = -1;
        for (int i = 0; i < messages.size(); i++) {
            if (AgentMessage.ROLE_USER.equals(messages.get(i).role())) {
                lastUser = i;
            }
        }
        return messages.subList(lastUser + 1, messages.size()).stream()
                .map(AgentMessage::content)
                .collect(java.util.stream.Collectors.joining("\n"));
    }

    /** 把所有消息正文拼起来：请求对象里存的是同一个 list 引用，后面的追问会追加进去。 */
    private static String allMessageText(CompletionRequest request) {
        return request.messages().stream()
                .map(AgentMessage::content)
                .filter(java.util.Objects::nonNull)
                .collect(java.util.stream.Collectors.joining("\n"));
    }

    /** 从请求里取出第一条工具结果（回灌给模型的那条）。 */
    private static String firstToolResult(CompletionRequest request) {
        return request.messages().stream()
                .filter(message -> AgentMessage.ROLE_TOOL.equals(message.role()))
                .map(AgentMessage::content)
                .findFirst()
                .orElseThrow(() -> new AssertionError("这次请求里没有工具结果：" + request.messages()));
    }

    private static int countOccurrences(String text, String needle) {
        int count = 0;
        int index = text.indexOf(needle);
        while (index >= 0) {
            count++;
            index = text.indexOf(needle, index + needle.length());
        }
        return count;
    }

    private long seedOrgWithOwnerMember(String orgCode, String memberKey) {
        Long orgId = jdbcTemplate.queryForObject(
                "INSERT INTO organization (name, code) VALUES ('助手测试组织', ?) RETURNING id",
                Long.class, orgCode);
        Long departmentId = jdbcTemplate.queryForObject(
                "INSERT INTO department (org_id, name, path, level) VALUES (?, '总部', '/', 1) RETURNING id",
                Long.class, orgId);
        jdbcTemplate.update(
                "INSERT INTO org_member (org_id, department_id, member_key, real_name, org_role, status) "
                        + "VALUES (?, ?, ?, '拥有者', 'OWNER', 'ACTIVE')",
                orgId, departmentId, memberKey);
        return orgId;
    }

    private JsonNode registerAccount(String phone, String nickname) throws Exception {
        // 手机号不能有两个用例复用：同一个号 60 秒内第二次发码会被频控拦掉（20005），
        // 而报错会出现在这里，看起来像业务坏了。踩过一次，所以加道闸。
        assertThat(USED_PHONES.add(phone))
                .withFailMessage("测试手机号 %s 被两个用例复用了，换一个没用过的号", phone)
                .isTrue();
        JsonNode sent = postJson("/api/v1/auth/sms/code", "{\"phone\":\"" + phone + "\"}");
        String code = sent.path("data").path("debugCode").asText();
        // 拿不到回显验证码（撞频控 / 通道变了）时在这里就说清楚，别让它以「验证码不能为空」的
        // 样子出现在几步之后的登录上 —— 那样的报错会被误读成业务坏了
        assertThat(code).withFailMessage("取验证码失败：%s", sent).isNotBlank();
        String registerToken = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"device-1\"}")
                .path("data").path("registerToken").asText();
        return postJsonWithBearer("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"" + nickname + "\",\"deviceId\":\"device-1\"}");
    }

    private JsonNode publicJson(String path) throws Exception {
        String response = mockMvc.perform(get(path))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
    }

    private JsonNode postJson(String path, String body) throws Exception {
        MvcResult result = mockMvc.perform(post(path)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn();
        String response = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
        // 失败时把响应体一起打出来：20005（验证码发太频）这类错误只看状态码猜不出来
        assertThat(result.getResponse().getStatus())
                .withFailMessage("POST %s 返回 %s：%s", path, result.getResponse().getStatus(), response)
                .isEqualTo(200);
        JsonNode json = objectMapper.readTree(response);
        assertThat(json.path("code").asInt())
                .withFailMessage("接口 %s 返回业务错误码 %s: %s", path,
                        json.path("code").asInt(), json.path("message").asText())
                .isZero();
        return json;
    }

    private JsonNode postJsonWithBearer(String path, String token, String body) throws Exception {
        String response = mockMvc.perform(post(path)
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode json = objectMapper.readTree(response);
        assertThat(json.path("code").asInt())
                .withFailMessage("接口 %s 返回业务错误码 %s: %s", path,
                        json.path("code").asInt(), json.path("message").asText())
                .isZero();
        return json;
    }
}
