package com.xatodo.bootstrap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 个人模块（日历 / 日程 / 待办）端到端验收，覆盖 spec §10.1 必测场景 3、6、7。
 */
@SpringBootTest
@AutoConfigureMockMvc
class PersonalModuleTest {

    private static final ZoneId SHANGHAI = ZoneId.of("Asia/Shanghai");

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;
    private static int redisPort;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private StringRedisTemplate redisTemplate;

    @DynamicPropertySource
    static void dependencies(DynamicPropertyRegistry registry) throws IOException {
        postgres = EmbeddedPostgres.builder().start();
        redisPort = findFreePort();
        redisServer = RedisServer.newRedisServer().port(redisPort).build();
        redisServer.start();

        registry.add("spring.datasource.url", () -> postgres.getJdbcUrl("postgres", "postgres"));
        registry.add("spring.datasource.username", () -> "postgres");
        registry.add("spring.datasource.password", () -> "postgres");
        registry.add("spring.data.redis.port", () -> redisPort);
        registry.add("xatodo.auth.expose-sms-code", () -> true);
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
    @DisplayName("首次访问日历列表时自动创建默认日历")
    void defaultCalendarIsCreatedOnFirstAccess() throws Exception {
        String token = registerAccount("13800000201");

        JsonNode calendars = getJson("/api/v1/calendars", token);
        assertThat(calendars.path("data")).hasSize(1);
        assertThat(calendars.path("data").get(0).path("name").asText()).isEqualTo("我的日程");
        assertThat(calendars.path("data").get(0).path("isDefault").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("单次日程只在相交的查询区间内出现，区间外不可见")
    void singleEventVisibleOnlyInsideRange() throws Exception {
        String token = registerAccount("13800000202");

        postJson("/api/v1/events", token,
                "{\"title\":\"产品评审\",\"startAt\":\"2026-10-05T14:00:00+08:00\","
                        + "\"endAt\":\"2026-10-05T15:00:00+08:00\",\"timezone\":\"Asia/Shanghai\"}");

        JsonNode hit = rangeQuery(token, "2026-10-05T00:00:00+08:00", "2026-10-06T00:00:00+08:00");
        assertThat(hit.path("data")).hasSize(1);
        assertThat(hit.path("data").get(0).path("title").asText()).isEqualTo("产品评审");

        JsonNode miss = rangeQuery(token, "2026-10-06T00:00:00+08:00", "2026-10-07T00:00:00+08:00");
        assertThat(miss.path("data")).isEmpty();
    }

    @Test
    @DisplayName("每周一/三/五 09:00 的重复日程按事件时区展开，两次出现跨两周共 6 次")
    void weeklyRecurrenceExpandsInEventTimezone() throws Exception {
        String token = registerAccount("13800000203");

        postJson("/api/v1/events", token,
                "{\"title\":\"站会\",\"startAt\":\"2026-10-05T09:00:00+08:00\","
                        + "\"endAt\":\"2026-10-05T09:30:00+08:00\",\"timezone\":\"Asia/Shanghai\","
                        + "\"rrule\":\"FREQ=WEEKLY;BYDAY=MO,WE,FR\"}");

        JsonNode result = rangeQuery(token, "2026-10-05T00:00:00+08:00", "2026-10-18T00:00:00+08:00");
        List<Instant> starts = startInstants(result.path("data"));

        assertThat(starts).containsExactly(
                local("2026-10-05T09:00"), local("2026-10-07T09:00"), local("2026-10-09T09:00"),
                local("2026-10-12T09:00"), local("2026-10-14T09:00"), local("2026-10-16T09:00"));
        assertThat(result.path("data").get(0).path("recurring").asBoolean()).isTrue();
        assertThat(result.path("data").get(0).path("occurrenceDate").asText()).isEqualTo("2026-10-05");
    }

    @Test
    @DisplayName("scope=THIS 只改某一次出现，其余实例保持原时间")
    void modifySingleOccurrenceKeepsOthersUntouched() throws Exception {
        String token = registerAccount("13800000204");
        long eventId = createWeeklyStandup(token);

        patchJson("/api/v1/events/" + eventId, token,
                "{\"scope\":\"THIS\",\"occurrenceDate\":\"2026-10-07\","
                        + "\"startAt\":\"2026-10-07T14:00:00+08:00\","
                        + "\"endAt\":\"2026-10-07T15:00:00+08:00\",\"title\":\"临时改期\"}");

        JsonNode result = rangeQuery(token, "2026-10-05T00:00:00+08:00", "2026-10-10T00:00:00+08:00");
        assertThat(startInstants(result.path("data"))).containsExactly(
                local("2026-10-05T09:00"), local("2026-10-07T14:00"), local("2026-10-09T09:00"));
        assertThat(result.path("data").get(1).path("title").asText()).isEqualTo("临时改期");
        assertThat(result.path("data").get(1).path("modified").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("scope=THIS 删除只移除当次出现，序列其余部分不受影响")
    void cancelSingleOccurrenceRemovesOnlyThatDay() throws Exception {
        String token = registerAccount("13800000205");
        long eventId = createWeeklyStandup(token);

        mockMvc.perform(delete("/api/v1/events/" + eventId)
                        .param("scope", "THIS")
                        .param("occurrenceDate", "2026-10-07")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));

        JsonNode result = rangeQuery(token, "2026-10-05T00:00:00+08:00", "2026-10-10T00:00:00+08:00");
        assertThat(startInstants(result.path("data"))).containsExactly(
                local("2026-10-05T09:00"), local("2026-10-09T09:00"));
    }

    @Test
    @DisplayName("scope=FUTURE 拆分序列：原序列截断，新序列从该次起套用新值")
    void editFutureSplitsSeries() throws Exception {
        String token = registerAccount("13800000206");
        long eventId = createWeeklyStandup(token);

        JsonNode split = patchJson("/api/v1/events/" + eventId, token,
                "{\"scope\":\"FUTURE\",\"occurrenceDate\":\"2026-10-12\","
                        + "\"startAt\":\"2026-10-12T10:00:00+08:00\","
                        + "\"endAt\":\"2026-10-12T10:30:00+08:00\",\"title\":\"新节奏站会\"}");
        long splitEventId = split.path("data").path("id").asLong();
        assertThat(splitEventId).isNotEqualTo(eventId);

        JsonNode result = rangeQuery(token, "2026-10-05T00:00:00+08:00", "2026-10-18T00:00:00+08:00");
        assertThat(startInstants(result.path("data")))
                .as("实际返回: %s", result.path("data").toString())
                .containsExactly(
                        local("2026-10-05T09:00"), local("2026-10-07T09:00"), local("2026-10-09T09:00"),
                        local("2026-10-12T10:00"), local("2026-10-14T10:00"), local("2026-10-16T10:00"));
        assertThat(result.path("data").get(0).path("title").asText()).isEqualTo("站会");
        assertThat(result.path("data").get(3).path("title").asText()).isEqualTo("新节奏站会");
    }

    @Test
    @DisplayName("非法 RRULE 被拒绝")
    void invalidRecurrenceRuleRejected() throws Exception {
        String token = registerAccount("13800000207");

        mockMvc.perform(post("/api/v1/events")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"坏规则\",\"startAt\":\"2026-10-05T09:00:00+08:00\","
                                + "\"endAt\":\"2026-10-05T10:00:00+08:00\","
                                + "\"rrule\":\"FREQ=EVERY_OTHER_BLUE_MOON\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(30002));
    }

    @Test
    @DisplayName("待办生命周期：创建、完成、子任务与两层限制")
    void taskLifecycleWithSubtask() throws Exception {
        String token = registerAccount("13800000208");

        JsonNode created = postJson("/api/v1/tasks", token,
                "{\"title\":\"写季度总结\",\"dueAt\":\"2026-10-09T18:00:00+08:00\",\"priority\":\"HIGH\"}");
        long taskId = created.path("data").path("id").asLong();
        assertThat(created.path("data").path("status").asText()).isEqualTo("TODO");

        JsonNode completed = postJson("/api/v1/tasks/" + taskId + "/complete", token, "{\"completed\":true}");
        assertThat(completed.path("data").path("status").asText()).isEqualTo("DONE");
        assertThat(completed.path("data").path("completedAt").isNull()).isFalse();

        JsonNode subtask = postJson("/api/v1/tasks", token,
                "{\"parentTaskId\":" + taskId + ",\"title\":\"整理数据\"}");
        long subtaskId = subtask.path("data").path("id").asLong();
        assertThat(subtask.path("data").path("parentTaskId").asLong()).isEqualTo(taskId);

        // 子任务不允许再嵌套
        mockMvc.perform(post("/api/v1/tasks")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"parentTaskId\":" + subtaskId + ",\"title\":\"三级任务\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(10002));

        // 删除父任务级联删除子任务
        mockMvc.perform(delete("/api/v1/tasks/" + taskId).header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.code").value(0));
        JsonNode remaining = getJson("/api/v1/tasks", token);
        assertThat(remaining.path("data")).isEmpty();
    }

    @Test
    @DisplayName("跨身份隔离：其他账号无法读取或修改他人日程")
    void otherIdentityCannotAccessOthersEvent() throws Exception {
        String ownerToken = registerAccount("13800000209");
        long eventId = createWeeklyStandup(ownerToken);

        String intruderToken = registerAccount("13800000210");

        mockMvc.perform(get("/api/v1/events/" + eventId).header("Authorization", "Bearer " + intruderToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));

        mockMvc.perform(patch("/api/v1/events/" + eventId)
                        .header("Authorization", "Bearer " + intruderToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"ALL\",\"title\":\"被篡改\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));

        JsonNode ownerView = getJson("/api/v1/events/" + eventId, ownerToken);
        assertThat(ownerView.path("data").path("title").asText()).isEqualTo("站会");
    }

    // ---------------------------------------------------------------- helpers

    private long createWeeklyStandup(String token) throws Exception {
        return postJson("/api/v1/events", token,
                "{\"title\":\"站会\",\"startAt\":\"2026-10-05T09:00:00+08:00\","
                        + "\"endAt\":\"2026-10-05T09:30:00+08:00\",\"timezone\":\"Asia/Shanghai\","
                        + "\"rrule\":\"FREQ=WEEKLY;BYDAY=MO,WE,FR\"}")
                .path("data").path("id").asLong();
    }

    private String registerAccount(String phone) throws Exception {
        String code = postJson("/api/v1/auth/sms/code", null, "{\"phone\":\"" + phone + "\"}")
                .path("data").path("debugCode").asText();
        String registerToken = postJson("/api/v1/auth/login/sms", null,
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\"}")
                .path("data").path("registerToken").asText();
        return postJson("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"用户" + phone.substring(phone.length() - 4) + "\",\"deviceId\":\"dev\"}")
                .path("data").path("accessToken").asText();
    }

    private List<Instant> startInstants(JsonNode array) {
        List<Instant> instants = new ArrayList<>();
        array.forEach(node -> instants.add(Instant.parse(node.path("startAt").asText())));
        return instants;
    }

    private static Instant local(String isoLocalDateTime) {
        return java.time.LocalDateTime.parse(isoLocalDateTime).atZone(SHANGHAI).toInstant();
    }

    private JsonNode getJson(String path, String token) throws Exception {
        return getJson(get(path).header("Authorization", "Bearer " + token));
    }

    /**
     * 范围查询用 .param() 传参，避免把 `+08:00` 的加号写进 URL 模板导致被二次编码。
     */
    private JsonNode rangeQuery(String token, String start, String end) throws Exception {
        return getJson(get("/api/v1/events")
                .param("start", start)
                .param("end", end)
                .header("Authorization", "Bearer " + token));
    }

    private JsonNode getJson(MockHttpServletRequestBuilder builder) throws Exception {
        return read(mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private JsonNode postJson(String path, String token, String body) throws Exception {
        MockHttpServletRequestBuilder builder = post(path)
                .contentType(MediaType.APPLICATION_JSON).content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return assertSuccess(read(mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8)), path);
    }

    private JsonNode patchJson(String path, String token, String body) throws Exception {
        MockHttpServletRequestBuilder builder = patch(path)
                .contentType(MediaType.APPLICATION_JSON).content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return assertSuccess(read(mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8)), path);
    }

    private JsonNode read(String body) throws Exception {
        return objectMapper.readTree(body);
    }

    private JsonNode assertSuccess(JsonNode json, String path) {
        assertThat(json.path("code").asInt())
                .withFailMessage("接口 %s 返回业务错误码 %s: %s", path,
                        json.path("code").asInt(), json.path("message").asText())
                .isZero();
        return json;
    }
}
