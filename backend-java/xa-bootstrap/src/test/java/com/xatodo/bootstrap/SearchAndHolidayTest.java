package com.xatodo.bootstrap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.xatodo.personal.holiday.HolidaySource;
import com.xatodo.personal.service.HolidayService;
import com.xatodo.personal.service.HolidaySyncService;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
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
import java.util.function.IntFunction;

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
@Import(SearchAndHolidayTest.StubUpstreamConfig.class)
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

    @Autowired
    private HolidaySyncService holidaySyncService;

    @Autowired
    private HolidayService holidayService;

    /**
     * 节假日缓存是**进程级**的，而测试会绕过缓存直接写库（那正是要验证的路径）。
     * 每个用例开始前清一次，读到的才是数据库的真实状态，用例之间也不会互相串。
     */
    @BeforeEach
    void clearHolidayCache() {
        holidayService.clearCache();
    }

    /** 上游假数据：默认给当年两条（1 放假 + 1 调休）。测试可以替换它，模拟上游格式变化。 */
    private static volatile IntFunction<String> upstream = SearchAndHolidayTest::defaultUpstream;

    /**
     * 定时同步从上游拉数据，测试不该依赖外网，所以这里把数据源换成假的。
     *
     * <p>拉取失败 / 年份错位 / 脏数据这些**分支**才是真正要测的部分，
     * 它们与「谁去把字节拉下来」无关。
     */
    @TestConfiguration
    static class StubUpstreamConfig {

        @Bean
        @Primary
        HolidaySource stubHolidaySource() {
            // 注意写成 lambda 而不是 `upstream::apply`：方法引用会捕获当前那个函数对象，
            // 之后测试再替换 upstream 就不生效了
            return year -> upstream.apply(year);
        }
    }

    private static String defaultUpstream(int year) {
        if (year != currentYear()) {
            // 次年在通知发布前上游就是没有数据：返回 null 表示「尚未发布」，不是错误
            return null;
        }
        return """
                {"year": %d, "papers": ["https://example.gov/notice"], "days": [
                  {"name": "国庆节", "date": "%d-10-01", "isOffDay": true},
                  {"name": "国庆节", "date": "%d-10-10", "isOffDay": false}
                ]}
                """.formatted(year, year, year);
    }

    private static int currentYear() {
        return java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).getYear();
    }

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

        createEvent(token, "评审会彩排", "2026-10-05T10:00:00+08:00");
        createEvent(token, "技术评审会", "2026-09-20T10:00:00+08:00");
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

        createEvent(mine, "我的评审会", "2026-10-05T10:00:00+08:00");
        createEvent(others, "别人的评审会", "2026-10-06T10:00:00+08:00");
        createTask(mine, "评审会待办", null);

        assertThat(titles(search(mine, "评审会").path("data"))).containsExactly("我的评审会", "评审会待办");
        assertThat(titles(search(mine, "评审会", "types", "TASK").path("data"))).containsExactly("评审会待办");
        assertThat(titles(search(mine, "评审会", "types", "EVENT").path("data"))).containsExactly("我的评审会");
    }

    @Test
    @DisplayName("关键字里的 % 和 _ 是字面量，不是通配符")
    void searchEscapesWildcards() throws Exception {
        String token = registerAccount("13800000404");

        createEvent(token, "50% 折扣复盘", "2026-10-05T10:00:00+08:00");
        createEvent(token, "普通复盘", "2026-10-06T10:00:00+08:00");

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
                "{\"title\":\"周会\",\"at\":\"2026-09-07T09:00:00+08:00\","
                        + "\"timezone\":\"Asia/Shanghai\","
                        + "\"rrule\":\"FREQ=WEEKLY;BYDAY=MO\"}");

        JsonNode item = search(token, "周会").path("data").get(0);

        assertThat(item.path("recurring").asBoolean()).isTrue();
        assertThat(item.path("occurrenceDate").isMissingNode()).as("重复命中必须带本次实例日期").isFalse();
        // 断言「形态」而不是「具体哪一天」：最近一次实例随运行日期变化，
        // 写死日期会让测试明天就红，而这里真正要守住的是「落在周一 09:00 的本地墙上时间」
        ZonedDateTime start = ZonedDateTime.parse(item.path("at").asText()).withZoneSameInstant(SHANGHAI);
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
        // 断言「包含这三条」而不是「一共三条」：同类里其它用例也会往这张表写，
        // 总数会互相影响，但「本用例插入的都在」是稳定的事实
        JsonNode wholeYear = getJson("/api/v1/holidays?year=2026", token).path("data");
        assertThat(datesOf(wholeYear.path("days")))
                .contains("2026-09-25", "2026-09-27", "2026-10-01");
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

    @Test
    @DisplayName("定时同步：拉上游数据入库，并立刻清掉缓存（否则界面还是旧的）")
    void holidaySyncUpsertsAndInvalidatesCache() throws Exception {
        String token = registerAccount("13800000409");
        int year = currentYear();
        String path = "/api/v1/holidays?year=" + year;

        int before = getJson(path, token).path("data").path("days").size();

        // 直接写库（绕过服务层缓存），再读一次：读到的必须还是旧值，否则说明缓存根本没生效
        insertHoliday(year + "-05-01", "劳动节", "HOLIDAY");
        int cached = getJson(path, token).path("data").path("days").size();
        assertThat(cached).as("库里改了但缓存未失效，这里应该还是旧值").isEqualTo(before);

        holidaySyncService.syncOnce();

        JsonNode after = getJson(path, token).path("data").path("days");
        assertThat(after.size()).as("同步后必须立刻可见（缓存被清）").isGreaterThan(cached);
        assertThat(titlesOfDays(after)).contains("国庆节");

        // 状态要如实上报：后台任务静默失败是排查噩梦
        JsonNode sync = publicJson("/api/v1/system/info").path("data").path("holidaySync");
        assertThat(sync.path("lastSuccessAt").asText()).as("成功时间必须上报").isNotEmpty();
        assertThat(sync.path("lastSyncedDays").asInt()).isEqualTo(2);
        assertThat(sync.path("lastError").isMissingNode()).as("成功时不应残留上次的失败原因").isTrue();
    }

    @Test
    @DisplayName("定时同步：上游数据缺字段时整年跳过、不写半截，并把失败原因记进状态")
    void holidaySyncSkipsMalformedUpstreamWithoutPartialWrite() throws Exception {
        String token = registerAccount("13800000410");
        int year = currentYear();
        String path = "/api/v1/holidays?year=" + year;
        List<String> beforeDates = datesOf(getJson(path, token).path("data").path("days"));

        // 第 2 条缺 date：整年都不该写进去（半截数据比旧数据更难排查）
        upstream = target -> target != year ? null : """
                {"year": %d, "days": [
                  {"name": "元旦", "date": "%d-01-01", "isOffDay": true},
                  {"name": "春节", "isOffDay": true}
                ]}
                """.formatted(target, target);
        try {
            holidaySyncService.syncOnce();
            JsonNode days = getJson(path, token).path("data").path("days");
            // 第一条是合法的「元旦 01-01」，但它同样不该落库——这一年整年放弃
            assertThat(titlesOfDays(days)).doesNotContain("元旦");
            // 比较日期集合而不是行数：行数会被同一测试类里其它用例直接写库影响
            assertThat(datesOf(days)).as("脏数据不该写进任何一行").isEqualTo(beforeDates);

            JsonNode failed = publicJson("/api/v1/system/info").path("data").path("holidaySync");
            assertThat(failed.path("lastError").asText()).contains("缺少日期或名称");
        } finally {
            // 恢复成正常上游再同步一次：失败状态要能被下一次成功清掉，也不给后续用例留脏状态
            upstream = SearchAndHolidayTest::defaultUpstream;
            holidaySyncService.syncOnce();
        }

        JsonNode sync = publicJson("/api/v1/system/info").path("data").path("holidaySync");
        assertThat(sync.path("lastError").isMissingNode()).as("成功一次后失败原因应被清掉").isTrue();
    }

    private List<String> titlesOfDays(JsonNode days) {
        List<String> names = new ArrayList<>();
        days.forEach(node -> names.add(node.path("name").asText()));
        return names;
    }

    private List<String> datesOf(JsonNode days) {
        List<String> dates = new ArrayList<>();
        days.forEach(node -> dates.add(node.path("date").asText()));
        return dates;
    }

    // ------------------------------------------------------------------ 工具

    private void insertHoliday(String date, String name, String dayType) {
        jdbcTemplate.update(
                "INSERT INTO holiday (country_code, holiday_date, name, day_type) VALUES (?, ?::date, ?, ?)"
                        + " ON CONFLICT (country_code, holiday_date) DO UPDATE SET name = EXCLUDED.name,"
                        + " day_type = EXCLUDED.day_type",
                "zh-CN", date, name, dayType);
    }

    private void createEvent(String token, String title, String at) throws Exception {
        postJson("/api/v1/events", token,
                "{\"title\":\"" + title + "\",\"at\":\"" + at + "\"}");
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
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"dev\"}")
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

    /** 公开接口：不带 Authorization 头（带个 "Bearer null" 反而会被过滤器当成坏令牌）。 */
    private JsonNode publicJson(String path) throws Exception {
        String body = mockMvc.perform(get(path)).andExpect(status().isOk()).andReturn()
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
