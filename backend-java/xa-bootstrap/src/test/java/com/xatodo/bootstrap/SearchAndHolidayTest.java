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
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 日历页检索与节假日（spec §4.1.7 / §5.11）。
 *
 * <p>这两块都容易被「看起来能用」蒙混过去，所以断言集中在最容易错的地方：
 * 检索不能受月份限制、不能跨身份、关键字里的 `%` 不能当通配符、重复日程要落到最近一次实例；
 * 节假日要能按年月取、能区分放假与调休上班。
 */
@SpringBootTest
@AutoConfigureMockMvc
class SearchAndHolidayTest {

    private static final ZoneId SHANGHAI = ZoneId.of("Asia/Shanghai");

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

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
    @DisplayName("检索跨日程与待办，按时间倒序、无时间的待办排最后")
    void searchSpansEventsAndTasksOrderedByTimeDesc() throws Exception {
        String token = registerAccount("13800000401");

        createEvent(token, "评审会彩排", "2026-10-05T10:00:00+08:00", "2026-10-05T11:00:00+08:00");
        createEvent(token, "技术评审会", "2026-09-20T10:00:00+08:00", "2026-09-20T11:00:00+08:00");
        createTask(token, "写评审会纪要", "2026-09-25T18:00:00+08:00");
        createTask(token, "评审会后续跟进", null);

        JsonNode data = search(token, "评审会").path("data");

        assertThat(titles(data)).containsExactly("评审会彩排", "写评审会纪要", "技术评审会", "评审会后续跟进");
        assertThat(data.get(0).path("type").asText()).isEqualTo("EVENT");
        assertThat(data.get(1).path("type").asText()).isEqualTo("TASK");
        // 无时间的待办排在最后，且 dueAt 为空
        assertThat(data.get(3).path("dueAt").isMissingNode()).isTrue();
    }

    @Test
    @DisplayName("检索只覆盖当前身份的数据，且能按 types 过滤")
    void searchIsScopedToOwnIdentityAndTypes() throws Exception {
        String mine = registerAccount("13800000402");
        String others = registerAccount("13800000403");

        createEvent(mine, "我的评审会", "2026-10-05T10:00:00+08:00", "2026-10-05T11:00:00+08:00");
        createEvent(others, "别人的评审会", "2026-10-06T10:00:00+08:00", "2026-10-06T11:00:00+08:00");
        createTask(mine, "评审会待办", null);

        assertThat(titles(search(mine, "评审会").path("data"))).containsExactly("我的评审会", "评审会待办");
        assertThat(titles(search(mine, "评审会", "types", "TASK").path("data"))).containsExactly("评审会待办");
        assertThat(titles(search(mine, "评审会", "types", "EVENT").path("data"))).containsExactly("我的评审会");
    }

    @Test
    @DisplayName("关键字里的 % 和 _ 是字面量，不是通配符")
    void searchEscapesWildcards() throws Exception {
        String token = registerAccount("13800000404");

        createEvent(token, "50% 折扣复盘", "2026-10-05T10:00:00+08:00", "2026-10-05T11:00:00+08:00");
        createEvent(token, "普通复盘", "2026-10-06T10:00:00+08:00", "2026-10-06T11:00:00+08:00");

        // 不转义时 `%` 会匹配到所有日程——那就成了「搜什么都灵」，用户反而找不到目标
        assertThat(titles(search(token, "50%").path("data"))).containsExactly("50% 折扣复盘");
        assertThat(titles(search(token, "_").path("data"))).isEmpty();
    }

    @Test
    @DisplayName("命中重复日程时返回最近一次实例与它的日期，而不是整条序列的起点")
    void searchResolvesUpcomingOccurrenceForRecurringEvent() throws Exception {
        String token = registerAccount("13800000405");

        // 从 2026-09-07（周一）起的每周一 09:00，永不结束
        postJson("/api/v1/events", token,
                "{\"title\":\"周会\",\"startAt\":\"2026-09-07T09:00:00+08:00\","
                        + "\"endAt\":\"2026-09-07T10:00:00+08:00\",\"timezone\":\"Asia/Shanghai\","
                        + "\"rrule\":\"FREQ=WEEKLY;BYDAY=MO\"}");

        JsonNode item = search(token, "周会").path("data").get(0);

        assertThat(item.path("recurring").asBoolean()).isTrue();
        assertThat(item.path("occurrenceDate").isMissingNode()).as("重复命中必须带本次实例日期").isFalse();
        // 断言「形态」而不是「具体哪一天」：最近一次实例随运行日期变化，
        // 写死日期会让测试明天就红，而这里真正要守住的是「落在周一 09:00 的本地墙上时间」
        ZonedDateTime start = ZonedDateTime.parse(item.path("startAt").asText()).withZoneSameInstant(SHANGHAI);
        assertThat(start.getHour()).isEqualTo(9);
        assertThat(start.getMinute()).isZero();
        assertThat(start.getDayOfWeek().getValue()).isEqualTo(1);
    }

    @Test
    @DisplayName("检索关键字为空时明确报参数错误，而不是把整库返回")
    void searchRejectsBlankKeyword() throws Exception {
        String token = registerAccount("13800000406");

        // 用 .param 传空格，避免 URL 模板把空白吃掉
        JsonNode json = read(mockMvc.perform(get("/api/v1/search")
                        .param("keyword", "   ")
                        .header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));

        assertThat(json.path("code").asInt()).isNotZero();
    }

    @Test
    @DisplayName("节假日按年月返回，并区分放假与调休上班")
    void holidaysAreReturnedByMonthWithDayType() throws Exception {
        insertHoliday("2026-09-25", "中秋节", "HOLIDAY");
        insertHoliday("2026-09-27", "中秋节", "WORKDAY");
        insertHoliday("2026-10-01", "国庆节", "HOLIDAY");
        String token = registerAccount("13800000407");

        JsonNode september = getJson("/api/v1/holidays?year=2026&month=9", token).path("data");
        assertThat(september.path("country").asText()).isEqualTo("zh-CN");
        assertThat(september.path("days")).hasSize(2);
        assertThat(september.path("days").get(0).path("date").asText()).isEqualTo("2026-09-25");
        assertThat(september.path("days").get(0).path("name").asText()).isEqualTo("中秋节");
        assertThat(september.path("days").get(0).path("dayType").asText()).isEqualTo("HOLIDAY");
        assertThat(september.path("days").get(1).path("dayType").asText()).isEqualTo("WORKDAY");

        // 省略 month 返回全年：日历页翻月时不该被月度切片限制
        JsonNode wholeYear = getJson("/api/v1/holidays?year=2026", token).path("data");
        assertThat(wholeYear.path("days")).hasSize(3);
        assertThat(wholeYear.path("month").isMissingNode()).isTrue();

        // country 大小写归一：zh-cn 与 zh-CN 必须命中同一份数据
        JsonNode lower = getJson("/api/v1/holidays?year=2026&month=9&country=zh-cn", token).path("data");
        assertThat(lower.path("days")).hasSize(2);
    }

    @Test
    @DisplayName("没有数据的年份返回空数组，不猜测也不硬编码兜底")
    void holidayYearWithoutDataReturnsEmpty() throws Exception {
        String token = registerAccount("13800000408");

        JsonNode data = getJson("/api/v1/holidays?year=2031", token).path("data");

        assertThat(data.path("year").asInt()).isEqualTo(2031);
        assertThat(data.path("days")).isEmpty();
    }

    // ------------------------------------------------------------------ 工具

    private void insertHoliday(String date, String name, String dayType) {
        jdbcTemplate.update(
                "INSERT INTO holiday (country_code, holiday_date, name, day_type) VALUES (?, ?::date, ?, ?)"
                        + " ON CONFLICT (country_code, holiday_date) DO UPDATE SET name = EXCLUDED.name,"
                        + " day_type = EXCLUDED.day_type",
                "zh-CN", date, name, dayType);
    }

    private void createEvent(String token, String title, String startAt, String endAt) throws Exception {
        postJson("/api/v1/events", token,
                "{\"title\":\"" + title + "\",\"startAt\":\"" + startAt + "\",\"endAt\":\"" + endAt + "\"}");
    }

    private void createTask(String token, String title, String dueAt) throws Exception {
        String body = dueAt == null
                ? "{\"title\":\"" + title + "\"}"
                : "{\"title\":\"" + title + "\",\"dueAt\":\"" + dueAt + "\"}";
        postJson("/api/v1/tasks", token, body);
    }

    /**
     * 检索。关键字一律用 {@code .param()} 传，不走 URL 模板：
     * 中文会被模板编码成不可预期的形式，而 `%` / `_` 还会被当成转义序列再解一遍——
     * 那样测的就不是服务端行为，而是测试自己有没有编码对了。
     *
     * @param extraParams 形如 ("types", "TASK") 的可选参数对
     */
    private JsonNode search(String token, String keyword, String... extraParams) throws Exception {
        MockHttpServletRequestBuilder builder = get("/api/v1/search")
                .param("keyword", keyword)
                .header("Authorization", "Bearer " + token);
        for (int i = 0; i + 1 < extraParams.length; i += 2) {
            builder = builder.param(extraParams[i], extraParams[i + 1]);
        }
        return assertSuccess(read(mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8)), "/api/v1/search");
    }

    private List<String> titles(JsonNode array) {
        List<String> titles = new ArrayList<>();
        array.forEach(node -> titles.add(node.path("title").asText()));
        return titles;
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

    private JsonNode getJson(String path, String token) throws Exception {
        String body = mockMvc.perform(get(path).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return assertSuccess(read(body), path);
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
