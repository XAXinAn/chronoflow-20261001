package com.chronoflow.bootstrap;

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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 上架合规的端到端验收（spec §12）。
 *
 * <p>对应应用宝《隐私政策提交内容及审核规范》里两条**只能在服务端验证**的要求：
 * <ol>
 *   <li>隐私政策等合规文本必须有一个**公开、免登录、纯静态**的地址（规范 §一）；</li>
 *   <li>账号注销必须真的「删除或匿名化」，且 App 内注销按钮对应的接口可用（规范 §2.7）。</li>
 * </ol>
 *
 * <p>App 侧的首启弹窗 / 非默认勾选 / 常驻入口由 {@code scripts/check_compliance.py}
 * 与 {@code app/test/compliance.test.ts} 盯着，这里不重复。
 */
@SpringBootTest
@AutoConfigureMockMvc
class ComplianceTest {

    /** 营业执照上的主体名称，必须与 docs/legal/privacy-policy.md 一致（规范 §2.2）。 */
    private static final String OPERATOR = "舟山市时纪云人工智能应用软件开发有限公司";

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private StringRedisTemplate redisTemplate;

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
    @DisplayName("合规文本公开可读、纯静态，且带上营业执照上的运营主体")
    void legalDocumentsArePublicAndStatic() throws Exception {
        for (String doc : new String[] {
                "privacy-policy", "user-agreement", "children-privacy",
                "personal-info-collected", "shared-info-with-third-parties"}) {
            String body = mockMvc.perform(get("/api/v1/legal/" + doc))
                    .andExpect(status().isOk())
                    .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
            assertThat(body)
                    .withFailMessage("合规文本 %s 没有渲染出内容", doc)
                    .contains("<html");
            // 页面必须是「能被自动化分析」的纯静态 HTML：有脚本就会被判不合规（规范 §一-2②）
            assertThat(body.toLowerCase())
                    .withFailMessage("合规文本 %s 里出现了 <script>，商店的检测会判不合规", doc)
                    .doesNotContain("<script");
        }

        String policy = mockMvc.perform(get("/api/v1/legal/privacy-policy"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        // 规范 §2.2：主体公司必须写在隐私政策里，且与商店后台的运营者一致
        assertThat(policy).contains(OPERATOR);
        // 规范 §2.7：必须写出注销步骤，且路径与 App 内真实入口一致
        assertThat(policy).contains("账号注销").contains("我的 → 隐私与合规 → 账号注销");
        // 规范 §2.8：不做个性化推送就必须明说
        assertThat(policy).contains("不提供个性化推荐");

        // 白名单之外的 slug 一律 404，别给路径穿越留口子
        mockMvc.perform(get("/api/v1/legal/../../etc/passwd"))
                .andExpect(status().is4xxClientError());
        mockMvc.perform(get("/api/v1/legal/not-a-document"))
                .andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("未登录不能注销账号（注销是账号级不可逆操作）")
    void deletionRequiresLogin() throws Exception {
        mockMvc.perform(post("/api/v1/me/deletion").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value(20001));
    }

    @Test
    @DisplayName("自助注销：个人信息被删除或匿名化、组织解绑、手机号释放")
    void selfServiceDeletionPurgesPersonalData() throws Exception {
        String phone = "13800000301";
        JsonNode personal = registerAccountWithPersonalIdentity(phone, "要注销的人");
        String accessToken = personal.path("data").path("accessToken").asText();
        long identityId = personal.path("data").path("identity").path("identityId").asLong();
        long accountId = personal.path("data").path("identity").path("accountId").asLong();

        // 造一点个人数据：一条日程 + 一个关联到它的待办
        long eventId = postJsonWithBearer("/api/v1/events", accessToken,
                "{\"title\":\"要消失的日程\",\"at\":\"2026-10-01T01:00:00Z\"}")
                .path("data").path("id").asLong();
        postJsonWithBearer("/api/v1/tasks", accessToken,
                "{\"title\":\"要消失的待办\",\"eventId\":" + eventId + "}");

        // 组织账号：管理员先导入成员，再用个人身份认领 —— 注销后这条绑定必须被解除
        seedOrgWithUnclaimedMember("XAOFF301", "S3001");
        postJsonWithBearer("/api/v1/org-accounts/login?deviceId=device-1", accessToken,
                "{\"org\":\"XAOFF301\",\"memberKey\":\"S3001\"}");
        // 认领会在组织下创建一条**独立的 ORG_MEMBER 身份**，绑定的是它而不是个人身份
        Long boundMemberId = jdbcTemplate.queryForObject(
                "SELECT om.id FROM org_member om JOIN organization o ON o.id = om.org_id"
                        + " WHERE o.code = 'XAOFF301'",
                Long.class);
        Long orgIdentityId = jdbcTemplate.queryForObject(
                "SELECT identity_id FROM org_member WHERE id = ?", Long.class, boundMemberId);
        assertThat(orgIdentityId).as("认领之后成员记录应当指向组织身份").isNotNull();

        // 别人（同事）的待办关联了这条日程：注销后对方的待办要留着，只是不再关联
        JsonNode colleague = registerAccountWithPersonalIdentity("13800000302", "同事");
        String colleagueToken = colleague.path("data").path("accessToken").asText();
        long colleagueIdentityId = colleague.path("data").path("identity").path("identityId").asLong();
        // 个人默认日历是「首次访问日历时」才建的：先摸一次，否则建待办会报「日历不存在」
        getJsonWithBearer("/api/v1/calendars", colleagueToken);
        // 接口层不允许把自己的待办关联到别人的日程（有专门用例盯着），所以这里直接落一行数据，
        // 只为验证「注销时不能连带删掉别人的待办」这条清理规则
        Long colleagueTaskId = jdbcTemplate.queryForObject(
                "INSERT INTO task (calendar_id, owner_identity_id, title, event_id)"
                        + " SELECT c.id, ?, '同事的待办', ? FROM calendar c WHERE c.owner_identity_id = ?"
                        + " RETURNING id",
                Long.class, colleagueIdentityId, eventId, colleagueIdentityId);
        assertThat(colleagueTaskId).isNotNull();

        postJsonWithBearer("/api/v1/me/deletion", accessToken, "{}");

        // 1) 令牌**立即**失效：访问令牌是无状态 JWT，光吊销刷新令牌只断掉续期，
        //    所以服务端同时写了作废标记，这里验证的就是那个标记真的生效（20008）。
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + accessToken))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value(20008));

        // 2) 账号被匿名化：手机号释放给「重新注册」、密码与第三方绑定清空、状态停用
        assertThat(jdbcTemplate.queryForObject(
                "SELECT phone FROM account WHERE id = ?", String.class, accountId))
                .isEqualTo("deleted-" + accountId);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT status FROM account WHERE id = ?", String.class, accountId))
                .isEqualTo("DISABLED");
        assertThat(jdbcTemplate.queryForObject(
                "SELECT (password_hash IS NULL) FROM account WHERE id = ?", Boolean.class, accountId))
                .isTrue();

        // 3) 个人身份停用并抹掉昵称/头像
        assertThat(jdbcTemplate.queryForObject(
                "SELECT status FROM identity WHERE id = ?", String.class, identityId))
                .isEqualTo("DISABLED");
        assertThat(jdbcTemplate.queryForObject(
                "SELECT nickname FROM identity WHERE id = ?", String.class, identityId))
                .isEqualTo("已注销用户");

        // 4) 个人数据被物理删除（日程 / 待办 / 个人日历一起走）
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM event WHERE creator_identity_id = ?", Integer.class, identityId))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM task WHERE owner_identity_id = ?", Integer.class, identityId))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM calendar WHERE owner_identity_id = ?", Integer.class, identityId))
                .isZero();

        // 5) 组织侧成员记录保留，但认领关系被解除（成员可重新认领）
        assertThat(jdbcTemplate.queryForObject(
                "SELECT (identity_id IS NULL) FROM org_member WHERE id = ?", Boolean.class, boundMemberId))
                .isTrue();

        // 6) 同事的待办还在，只是不再指向那条已经消失的日程（不该连带删掉别人的数据）
        assertThat(jdbcTemplate.queryForObject(
                "SELECT (event_id IS NULL) FROM task WHERE id = ?", Boolean.class, colleagueTaskId))
                .isTrue();

        // 7) 手机号真的被释放：同一个号可以重新注册成一个全新账号
        injectCode(phone, "654321");
        JsonNode relogin = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"654321\",\"deviceId\":\"device-9\"}");
        assertThat(relogin.path("data").path("needRegister").asBoolean())
                .as("注销后同一手机号应当被当作新用户")
                .isTrue();
    }

    // ---------------------------------------------------------------- helpers

    private void injectCode(String phone, String code) {
        redisTemplate.opsForValue().set("sms:code:" + phone, code, Duration.ofMinutes(5));
    }

    private JsonNode registerAccountWithPersonalIdentity(String phone, String nickname) throws Exception {
        String code = postJson("/api/v1/auth/sms/code", "{\"phone\":\"" + phone + "\"}")
                .path("data").path("debugCode").asText();
        String registerToken = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"device-1\"}")
                .path("data").path("registerToken").asText();
        return postJsonWithBearer("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"" + nickname + "\",\"deviceId\":\"device-1\"}");
    }

    /** 造一个「管理员刚导入、还没人认领」的成员（spec §3.1）。 */
    private void seedOrgWithUnclaimedMember(String orgCode, String memberKey) {
        Long orgId = jdbcTemplate.queryForObject(
                "INSERT INTO organization (name, code) VALUES ('心安科技', ?) RETURNING id",
                Long.class, orgCode);
        Long departmentId = jdbcTemplate.queryForObject(
                "INSERT INTO department (org_id, name, path, level) VALUES (?, '总部', '/', 1) RETURNING id",
                Long.class, orgId);
        jdbcTemplate.update(
                "INSERT INTO org_member (org_id, department_id, member_key, real_name, org_role, status) "
                        + "VALUES (?, ?, ?, '张三', 'MEMBER', 'ACTIVE')",
                orgId, departmentId, memberKey);
    }

    private JsonNode postJson(String path, String body) throws Exception {
        String response = mockMvc.perform(post(path)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
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

    private JsonNode getJsonWithBearer(String path, String token) throws Exception {
        String response = mockMvc.perform(get(path).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
    }
}
