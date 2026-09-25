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
    @DisplayName("待办可带图片附件：读回来还在，外链地址被拒绝")
    void taskImagesAreStoredAndValidated() throws Exception {
        String token = registerAccount("13800000209");

        long taskId = postJson("/api/v1/tasks", token,
                "{\"title\":\"拍的通知\",\"images\":[\"/uploads/notice.png\"]}")
                .path("data").path("id").asLong();

        // 必须重新 GET 读回来：更新接口返回的是内存对象，断言它会假通过
        JsonNode reread = getJson("/api/v1/tasks/" + taskId, token).path("data");
        assertThat(reread.path("images").get(0).asText()).isEqualTo("/uploads/notice.png");

        // 外链必须被拒：否则等于让别人在我们的用户界面上打广告
        mockMvc.perform(post("/api/v1/tasks")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"外链\",\"images\":[\"https://evil.example/a.png\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(10002));

        // 传空数组 = 删光图片（null 才是「不修改」）
        patchJson("/api/v1/tasks/" + taskId, token, "{\"images\":[]}");
        assertThat(getJson("/api/v1/tasks/" + taskId, token).path("data").path("images").isMissingNode())
                .as("清空后不再返回 images 字段（non_null 序列化）").isTrue();
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

    @Test
    @DisplayName("提醒：整体覆盖设置、可查询，且不能挂到他人日程上")
    void remindersAreScopedToOwnedTargets() throws Exception {
        String token = registerAccount("13800000220");
        long eventId = createWeeklyStandup(token);

        JsonNode saved = putJson("/api/v1/reminders", token,
                "{\"targetType\":\"EVENT\",\"targetId\":" + eventId
                        + ",\"items\":[{\"minutesBefore\":60},{\"minutesBefore\":15}]}");
        assertThat(saved.path("data")).hasSize(2);

        JsonNode listed = getJson("/api/v1/reminders?targetType=EVENT&targetId=" + eventId, token);
        assertThat(listed.path("data")).hasSize(2);
        assertThat(listed.path("data").get(0).path("minutesBefore").asInt()).isEqualTo(15);

        // 整体覆盖：只留一条
        JsonNode replaced = putJson("/api/v1/reminders", token,
                "{\"targetType\":\"EVENT\",\"targetId\":" + eventId + ",\"items\":[{\"minutesBefore\":30}]}");
        assertThat(replaced.path("data")).hasSize(1);

        // 清空
        JsonNode cleared = putJson("/api/v1/reminders", token,
                "{\"targetType\":\"EVENT\",\"targetId\":" + eventId + ",\"items\":[]}");
        assertThat(cleared.path("data")).isEmpty();

        // 他人日程不可挂提醒
        String intruder = registerAccount("13800000221");
        mockMvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .put("/api/v1/reminders")
                        .header("Authorization", "Bearer " + intruder)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"targetType\":\"EVENT\",\"targetId\":" + eventId
                                + ",\"items\":[{\"minutesBefore\":15}]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));
    }

    @Test
    @DisplayName("日程与待办可互转，来源标记取消")
    void convertBetweenEventAndTask() throws Exception {
        String token = registerAccount("13800000222");

        long eventId = postJson("/api/v1/events", token,
                "{\"title\":\"改成待办\",\"startAt\":\"2026-10-05T09:00:00+08:00\","
                        + "\"endAt\":\"2026-10-05T10:00:00+08:00\",\"timezone\":\"Asia/Shanghai\"}")
                .path("data").path("id").asLong();

        JsonNode task = postJson("/api/v1/events/" + eventId + "/convert-to-task", token, "{}");
        assertThat(task.path("data").path("title").asText()).isEqualTo("改成待办");
        assertThat(task.path("data").path("status").asText()).isEqualTo("TODO");
        // 结束时间转为截止时间
        assertThat(task.path("data").path("dueAt").asText()).startsWith("2026-10-05T02:00:00");

        // 原日程已取消，不再出现在范围查询里
        JsonNode events = rangeQuery(token, "2026-10-05T00:00:00+08:00", "2026-10-06T00:00:00+08:00");
        assertThat(events.path("data")).isEmpty();

        // 待办 → 日程：未给 endAt 时默认 1 小时
        long taskId = task.path("data").path("id").asLong();
        JsonNode createdEvent = postJson("/api/v1/tasks/" + taskId + "/convert-to-event", token,
                "{\"startAt\":\"2026-10-06T09:00:00+08:00\"}");
        assertThat(createdEvent.path("data").path("startAt").asText()).startsWith("2026-10-06T01:00:00");
        assertThat(createdEvent.path("data").path("endAt").asText()).startsWith("2026-10-06T02:00:00");

        JsonNode after = rangeQuery(token, "2026-10-06T00:00:00+08:00", "2026-10-07T00:00:00+08:00");
        assertThat(after.path("data")).hasSize(1);
        assertThat(after.path("data").get(0).path("title").asText()).isEqualTo("改成待办");
    }

    @Test
    @DisplayName("结构化地点与扩展字段：落库后原样返回，坐标统一标注为 GCJ-02")
    void richEventFieldsArePersisted() throws Exception {
        String token = registerAccount("13800000231");

        JsonNode created = postJson("/api/v1/events", token, """
                {"title":"季度评审","description":"带上 OKR","startAt":"2026-10-08T09:00:00+08:00",
                 "endAt":"2026-10-08T11:00:00+08:00","timezone":"Asia/Shanghai",
                 "locationName":"北京南站","locationAddress":"北京市丰台区永外大街车站路12号",
                 "latitude":39.865400,"longitude":116.378700,"poiId":"BJ-NAN",
                 "priority":"HIGH","category":"会议","url":"https://example.com/meet",
                 "availability":"FREE","status":"TENTATIVE","travelTimeMinutes":30}
                """).path("data");

        assertThat(created.path("locationName").asText()).isEqualTo("北京南站");
        assertThat(created.path("locationAddress").asText()).isEqualTo("北京市丰台区永外大街车站路12号");
        assertThat(created.path("latitude").decimalValue()).isEqualByComparingTo("39.8654");
        assertThat(created.path("longitude").decimalValue()).isEqualByComparingTo("116.3787");
        assertThat(created.path("poiId").asText()).isEqualTo("BJ-NAN");
        // 客户端不声明坐标系，服务端统一按 GCJ-02 标注
        assertThat(created.path("coordinateSystem").asText()).isEqualTo("GCJ-02");
        assertThat(created.path("priority").asText()).isEqualTo("HIGH");
        assertThat(created.path("category").asText()).isEqualTo("会议");
        assertThat(created.path("url").asText()).isEqualTo("https://example.com/meet");
        assertThat(created.path("availability").asText()).isEqualTo("FREE");
        assertThat(created.path("status").asText()).isEqualTo("TENTATIVE");
        assertThat(created.path("travelTimeMinutes").asInt()).isEqualTo(30);

        // 列表接口（展开后的实例）同样要带地点，否则日历页只能显示标题
        JsonNode range = rangeQuery(token, "2026-10-08T00:00:00+08:00", "2026-10-09T00:00:00+08:00");
        assertThat(range.path("data").get(0).path("locationName").asText()).isEqualTo("北京南站");

        // 详情接口
        long eventId = created.path("id").asLong();
        JsonNode detail = getJson("/api/v1/events/" + eventId, token);
        assertThat(detail.path("data").path("locationName").asText()).isEqualTo("北京南站");
    }

    @Test
    @DisplayName("经纬度必须成对提供，半个坐标点直接拒绝")
    void halfCoordinateRejected() throws Exception {
        String token = registerAccount("13800000232");

        mockMvc.perform(post("/api/v1/events")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"只有纬度\",\"startAt\":\"2026-10-09T09:00:00+08:00\","
                                + "\"endAt\":\"2026-10-09T10:00:00+08:00\",\"latitude\":39.9}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(10002));
    }

    @Test
    @DisplayName("枚举取值非法时给出业务错误码，而不是让数据库约束抛异常")
    void invalidEnumsRejected() throws Exception {
        String token = registerAccount("13800000233");
        String common = "\"startAt\":\"2026-10-10T09:00:00+08:00\",\"endAt\":\"2026-10-10T10:00:00+08:00\",";

        for (String bad : new String[]{"availability", "priority", "status"}) {
            mockMvc.perform(post("/api/v1/events")
                            .header("Authorization", "Bearer " + token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"title\":\"非法枚举\"," + common + "\"" + bad + "\":\"NOT_A_VALUE\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.code").value(10002));
        }
    }

    @Test
    @DisplayName("清空地点时坐标一并清掉，不留「有坐标没名字」的脏数据")
    void clearingPlaceAlsoClearsCoordinates() throws Exception {
        String token = registerAccount("13800000234");
        long eventId = postJson("/api/v1/events", token,
                "{\"title\":\"带地点\",\"startAt\":\"2026-10-11T09:00:00+08:00\","
                        + "\"endAt\":\"2026-10-11T10:00:00+08:00\",\"locationName\":\"外滩\","
                        + "\"latitude\":31.24,\"longitude\":121.49,\"poiId\":\"SH-BUND\"}")
                .path("data").path("id").asLong();

        JsonNode updated = patchJson("/api/v1/events/" + eventId, token, "{\"locationName\":\"\"}").path("data");
        assertThat(updated.path("locationName").isMissingNode() || updated.path("locationName").isNull()).isTrue();

        // 必须重新读一次才算数：PATCH 的返回体来自内存里的实体，
        // 而 MyBatis-Plus 默认不写 null 字段——只看返回体会漏掉「清空其实没落库」这种 bug。
        JsonNode reread = getJson("/api/v1/events/" + eventId, token).path("data");
        assertThat(reread.path("locationName").isMissingNode() || reread.path("locationName").isNull()).isTrue();
        assertThat(reread.path("locationAddress").isMissingNode() || reread.path("locationAddress").isNull()).isTrue();
        assertThat(reread.path("latitude").isMissingNode() || reread.path("latitude").isNull()).isTrue();
        assertThat(reread.path("longitude").isMissingNode() || reread.path("longitude").isNull()).isTrue();
    }

    @Test
    @DisplayName("待办关联日程：一个日程可挂多个待办，解绑与「删日程不删待办」都要成立")
    void taskLinksToEvent() throws Exception {
        String token = registerAccount("13800000243");
        long eventId = postJson("/api/v1/events", token,
                "{\"title\":\"季度评审\",\"startAt\":\"2026-10-20T09:00:00+08:00\","
                        + "\"endAt\":\"2026-10-20T11:00:00+08:00\"}")
                .path("data").path("id").asLong();

        // 一个日程可以关联多个待办
        long first = postJson("/api/v1/tasks", token,
                "{\"title\":\"准备材料\",\"eventId\":" + eventId + "}").path("data").path("id").asLong();
        long second = postJson("/api/v1/tasks", token,
                "{\"title\":\"订会议室\",\"eventId\":" + eventId + "}").path("data").path("id").asLong();

        JsonNode list = getJson("/api/v1/tasks", token).path("data");
        assertThat(list).hasSize(2);
        for (JsonNode task : list) {
            assertThat(task.path("eventId").asLong()).isEqualTo(eventId);
            // 标题由服务端带出来，省掉客户端再查一次日程
            assertThat(task.path("eventTitle").asText()).isEqualTo("季度评审");
        }

        // 解绑：null 在 PATCH 里是「不修改」，必须靠 clearEvent
        JsonNode unlinked = patchJson("/api/v1/tasks/" + first, token, "{\"clearEvent\":true}").path("data");
        assertThat(unlinked.path("eventId").isMissingNode() || unlinked.path("eventId").isNull()).isTrue();
        JsonNode reread = getJson("/api/v1/tasks/" + first, token).path("data");
        assertThat(reread.path("eventId").isMissingNode() || reread.path("eventId").isNull()).isTrue();

        // 删日程只解除关联，不删待办
        mockMvc.perform(delete("/api/v1/events/" + eventId).header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.code").value(0));
        JsonNode remaining = getJson("/api/v1/tasks", token).path("data");
        assertThat(remaining).hasSize(2);
        for (JsonNode task : remaining) {
            assertThat(task.path("eventId").isMissingNode() || task.path("eventId").isNull()).isTrue();
        }
        assertThat(getJson("/api/v1/tasks/" + second, token).path("data").path("title").asText())
                .isEqualTo("订会议室");
    }

    @Test
    @DisplayName("待办不能关联到别人的日程")
    void taskCannotLinkToOthersEvent() throws Exception {
        String owner = registerAccount("13800000244");
        String stranger = registerAccount("13800000245");
        long eventId = postJson("/api/v1/events", owner,
                "{\"title\":\"私人日程\",\"startAt\":\"2026-10-21T09:00:00+08:00\","
                        + "\"endAt\":\"2026-10-21T10:00:00+08:00\"}")
                .path("data").path("id").asLong();

        mockMvc.perform(post("/api/v1/tasks")
                        .header("Authorization", "Bearer " + stranger)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"越权关联\",\"eventId\":" + eventId + "}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));
    }

    @Test
    @DisplayName("待办可编辑：改标题/优先级，且截止时间能被显式清空回到「待安排」")
    void taskUpdateAndClearDueAt() throws Exception {
        String token = registerAccount("13800000241");
        long taskId = postJson("/api/v1/tasks", token,
                "{\"title\":\"交周报\",\"dueAt\":\"2026-10-09T18:00:00+08:00\",\"priority\":\"LOW\"}")
                .path("data").path("id").asLong();

        // 普通编辑：只改标题与优先级，截止时间不应被动到
        JsonNode edited = patchJson("/api/v1/tasks/" + taskId, token,
                "{\"title\":\"交月报\",\"priority\":\"HIGH\"}").path("data");
        assertThat(edited.path("title").asText()).isEqualTo("交月报");
        assertThat(edited.path("priority").asText()).isEqualTo("HIGH");
        assertThat(edited.path("dueAt").isMissingNode() || edited.path("dueAt").isNull()).isFalse();

        // 清空截止时间：PATCH 里 null 是「不修改」，必须靠 clearDueAt 显式表达，
        // 否则用户设过截止时间后就再也回不到「待安排」
        JsonNode cleared = patchJson("/api/v1/tasks/" + taskId, token, "{\"clearDueAt\":true}").path("data");
        assertThat(cleared.path("dueAt").isMissingNode() || cleared.path("dueAt").isNull()).isTrue();

        // 详情接口读回来也应是空的
        JsonNode detail = getJson("/api/v1/tasks/" + taskId, token).path("data");
        assertThat(detail.path("dueAt").isMissingNode() || detail.path("dueAt").isNull()).isTrue();
    }

    @Test
    @DisplayName("待办可删除，删除后不再出现在列表里")
    void taskDelete() throws Exception {
        String token = registerAccount("13800000242");
        long taskId = postJson("/api/v1/tasks", token, "{\"title\":\"临时待办\"}")
                .path("data").path("id").asLong();

        mockMvc.perform(delete("/api/v1/tasks/" + taskId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));

        assertThat(getJson("/api/v1/tasks", token).path("data")).isEmpty();
    }

    @Test
    @DisplayName("未配置地图 Key 时地点服务降级为内置地点集，且降级态对客户端可见")
    void geoFallsBackToLocalProviderWithoutKey() throws Exception {
        String token = registerAccount("13800000235");

        JsonNode config = getJson("/api/v1/geo/config", token);
        // 测试环境没有 GEO_AMAP_KEY，因此必然走降级实现
        assertThat(config.path("data").path("provider").asText()).isEqualTo("local");
        assertThat(config.path("data").path("configuredProvider").asText()).isEqualTo("amap");
        assertThat(config.path("data").path("degraded").asBoolean()).isTrue();
        assertThat(config.path("data").path("degradedReason").asText()).contains("降级");

        JsonNode found = getJson(get("/api/v1/geo/places").param("keyword", "北京南站")
                .header("Authorization", "Bearer " + token));
        assertThat(found.path("data")).hasSize(1);
        assertThat(found.path("data").get(0).path("name").asText()).isEqualTo("北京南站");
        assertThat(found.path("data").get(0).path("latitude").decimalValue()).isEqualByComparingTo("39.8654");
    }

    @Test
    @DisplayName("逆地理编码返回最近的内置地点；附近没有已知地点时如实返回自定义地点")
    void geoReverseGeocode() throws Exception {
        String token = registerAccount("13800000236");

        JsonNode near = getJson(get("/api/v1/geo/regeo")
                .param("lat", "39.9088").param("lng", "116.4571")
                .header("Authorization", "Bearer " + token));
        assertThat(near.path("data").path("name").asText()).isEqualTo("国贸三期");

        JsonNode nowhere = getJson(get("/api/v1/geo/regeo")
                .param("lat", "0.0").param("lng", "0.0")
                .header("Authorization", "Bearer " + token));
        assertThat(nowhere.path("data").path("name").asText()).isEqualTo("自定义地点");
    }

    @Test
    @DisplayName("地点搜索必须带关键字，逆地理必须带坐标")
    void geoRequiresParameters() throws Exception {
        String token = registerAccount("13800000237");

        mockMvc.perform(get("/api/v1/geo/places").param("keyword", "")
                        .header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.code").value(10001));

        mockMvc.perform(get("/api/v1/geo/regeo").param("lat", "39.9").param("lng", "200")
                        .header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.code").value(10002));
    }

    private JsonNode putJson(String path, String token, String body) throws Exception {
        var builder = org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(path)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        String response = mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
    }

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
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"dev\"}")
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
