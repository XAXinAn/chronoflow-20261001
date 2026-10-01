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

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 平台超管后台端到端验收，覆盖 spec §10.1 必测场景 9、10。
 */
@SpringBootTest
@AutoConfigureMockMvc
class AdminModuleTest {

    private static final String BOOTSTRAP_USERNAME = "admin";
    private static final String BOOTSTRAP_PASSWORD = "admin123456";

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;
    private static int redisPort;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

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
        registry.add("chronoflow.auth.expose-sms-code", () -> true);
        registry.add("chronoflow.admin.bootstrap-username", () -> BOOTSTRAP_USERNAME);
        registry.add("chronoflow.admin.bootstrap-password", () -> BOOTSTRAP_PASSWORD);
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
    @DisplayName("初始超管可登录，错误密码连续 5 次后锁定")
    void loginAndLockAfterRepeatedFailures() throws Exception {
        String token = adminLogin(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
        assertThat(token).isNotBlank();

        // 新建一个管理员专门用于验证锁定，避免影响超管账号
        String adminToken = token;
        postJson("/api/v1/admin/admins", adminToken,
                "{\"username\":\"locktest\",\"password\":\"locktest123\",\"role\":\"SUPER_ADMIN\"}");

        for (int attempt = 0; attempt < 5; attempt++) {
            mockMvc.perform(post("/api/v1/admin/auth/login")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"locktest\",\"password\":\"wrong-password\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.code").value(60001));
        }

        // 第 6 次即使密码正确也因锁定而失败
        mockMvc.perform(post("/api/v1/admin/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"locktest\",\"password\":\"locktest123\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(60001))
                .andExpect(jsonPath("$.message").value("账号已锁定，请稍后再试"));
    }

    @Test
    @DisplayName("创建组织时同步创建首位组织管理员")
    void createOrganizationWithFirstAdmin() throws Exception {
        String token = adminLogin(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);

        JsonNode created = postJson("/api/v1/admin/organizations", token,
                "{\"name\":\"心安科技\",\"code\":\"XAKJ\",\"maxMembers\":200,"
                        + "\"adminUsername\":\"xakj_admin\",\"adminPassword\":\"xakj123456\","
                        + "\"adminRealName\":\"组织管理员\"}");
        assertThat(created.path("data").path("code").asText()).isEqualTo("XAKJ");
        assertThat(created.path("data").path("status").asText()).isEqualTo("ACTIVE");

        // 首位组织管理员可以直接登录后台
        String orgAdminToken = adminLogin("xakj_admin", "xakj123456");
        JsonNode me = getJson("/api/v1/admin/me", orgAdminToken);
        assertThat(me.path("data").path("role").asText()).isEqualTo("ORG_ADMIN");
        assertThat(me.path("data").path("orgId").asLong()).isEqualTo(created.path("data").path("id").asLong());

        // 组织管理员不是超管，不能访问组织管理接口
        mockMvc.perform(get("/api/v1/admin/organizations").header("Authorization", "Bearer " + orgAdminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));
    }

    @Test
    @DisplayName("停用组织后该组织成员无法再访问组织接口")
    void suspendedOrganizationBlocksMemberAccess() throws Exception {
        String token = adminLogin(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
        long orgId = createOrganization(token, "停用测试", "SUSPENDORG", "suspend_admin", "13800003101");

        String memberToken = loginOrgMemberInExistingOrg("13800003101", orgId);
        assertThat(getJson("/api/v1/org/current", memberToken).path("data").path("orgId").asLong())
                .isEqualTo(orgId);

        postJson("/api/v1/admin/organizations/" + orgId + "/status", token, "{\"status\":\"SUSPENDED\"}");

        mockMvc.perform(get("/api/v1/org/current").header("Authorization", "Bearer " + memberToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003))
                .andExpect(jsonPath("$.message").value("组织已停用"));
    }

    @Test
    @DisplayName("封禁账号后其刷新令牌立即失效")
    void bannedAccountCannotRefresh() throws Exception {
        String token = adminLogin(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
        long orgId = createOrganization(token, "封禁测试", "BANORG", "ban_admin", "13800003102");

        LoginResult member = loginOrgMemberWithTokens("13800003102", orgId);

        JsonNode search = getJson("/api/v1/admin/accounts?phone=13800003102", token);
        long accountId = search.path("data").get(0).path("accountId").asLong();

        postJson("/api/v1/admin/accounts/" + accountId + "/status", token, "{\"status\":\"DISABLED\"}");

        mockMvc.perform(post("/api/v1/auth/token/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + member.refreshToken() + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20007));
    }

    @Test
    @DisplayName("全局配置按 key upsert，并可查询")
    void systemConfigUpsertAndList() throws Exception {
        String token = adminLogin(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);

        postJson("/api/v1/admin/organizations", token,
                "{\"name\":\"配置测试\",\"code\":\"CFGORG\",\"adminUsername\":\"cfg_admin\","
                        + "\"adminPassword\":\"cfg123456\"}");

        JsonNode first = putJson("/api/v1/admin/configs/registration.enabled", token,
                "{\"configValue\":\"true\",\"description\":\"是否开放注册\"}");
        assertThat(first.path("data").path("configValue").asText()).isEqualTo("true");

        JsonNode second = putJson("/api/v1/admin/configs/registration.enabled", token,
                "{\"configValue\":\"false\"}");
        assertThat(second.path("data").path("configValue").asText()).isEqualTo("false");

        JsonNode list = getJson("/api/v1/admin/configs", token);
        assertThat(list.path("data")).hasSize(1);
    }

    @Test
    @DisplayName("看板统计与审计日志反映真实数据")
    void dashboardAndAuditLogs() throws Exception {
        String token = adminLogin(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);

        createOrganization(token, "看板测试", "DASHORG", "dash_admin", "13800003103");

        JsonNode stats = getJson("/api/v1/admin/dashboard/stats", token);
        assertThat(stats.path("data").path("organizationCount").asLong()).isPositive();
        assertThat(stats.path("data").path("accountCount").asLong()).isPositive();

        JsonNode logs = getJson("/api/v1/admin/audit-logs?action=ORG_CREATE&limit=50", token);
        assertThat(logs.path("data")).isNotEmpty();
        assertThat(logs.path("data").get(0).path("action").asText()).isEqualTo("ORG_CREATE");
        assertThat(logs.path("data").get(0).path("actorName").asText()).isEqualTo(BOOTSTRAP_USERNAME);
    }

    @Test
    @DisplayName("超管建组织可选预置首位拥有者：组织一建好就能被认领（spec §3.4）")
    void organizationCanBeCreatedWithPresetOwner() throws Exception {
        String token = adminLogin(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
        String phone = "13800003201";

        JsonNode created = postJson("/api/v1/admin/organizations", token,
                "{\"name\":\"预置组织\",\"code\":\"PRESETORG\",\"adminUsername\":\"preset_admin\","
                        + "\"adminPassword\":\"presetadmin123\",\"ownerMemberKey\":\"" + phone + "\","
                        + "\"ownerRealName\":\"预置拥有者\"}");
        assertThat(created.path("code").asInt())
                .as("预置拥有者不该让建组织失败: %s", created).isZero();
        long orgId = created.path("data").path("id").asLong();

        // 关键：这条链路**没有人工播种任何部门或成员**，
        // 但成员照样能认领，且一进来就是组织管理员（否则组织日历没人管得了）
        String orgToken = loginOrgMemberInExistingOrg(phone, orgId);
        JsonNode current = getJson("/api/v1/org/current", orgToken);
        assertThat(current.path("data").path("realName").asText()).isEqualTo("预置拥有者");
        assertThat(current.path("data").path("orgAdmin").asBoolean()).isTrue();

        // 根部门「总部」也建好了，成员挂在它下面 —— 路径结尾必须带斜杠（spec §6.4）
        Long deptId = jdbcTemplate.queryForObject(
                "SELECT id FROM department WHERE org_id = ? AND name = '总部' AND parent_id IS NULL",
                Long.class, orgId);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT path FROM department WHERE id = ?", String.class, deptId))
                .isEqualTo("/" + deptId + "/");
        assertThat(jdbcTemplate.queryForObject(
                "SELECT department_id FROM org_member WHERE org_id = ?", Long.class, orgId))
                .isEqualTo(deptId);
    }

    // ---------------------------------------------------------------- helpers

    private record LoginResult(String accessToken, String refreshToken) {
    }

    private String adminLogin(String username, String password) throws Exception {
        return postJson("/api/v1/admin/auth/login", null,
                "{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}")
                .path("data").path("accessToken").asText();
    }

    private long createOrganization(String adminToken, String name, String code,
                                    String adminUsername, String ownerPhone) throws Exception {
        JsonNode created = postJson("/api/v1/admin/organizations", adminToken,
                "{\"name\":\"" + name + "\",\"code\":\"" + code + "\","
                        + "\"adminUsername\":\"" + adminUsername + "\",\"adminPassword\":\"" + adminUsername + "123\"}");
        long orgId = created.path("data").path("id").asLong();

        // 播种一个部门与「未被认领的组织成员」，用于验证组织侧行为：
        // 成员身份由本人认领组织账号时产生（spec §3.1 / §3.2）
        Long deptId = jdbcTemplate.queryForObject(
                "INSERT INTO department (org_id, name, path, level) VALUES (?, '总部', '/0/', 1) RETURNING id",
                Long.class, orgId);
        jdbcTemplate.update("UPDATE department SET path = '/' || id || '/' WHERE id = ?", deptId);
        jdbcTemplate.update(
                "INSERT INTO org_member (org_id, department_id, member_key, real_name, org_role, status) "
                        + "VALUES (?, ?, ?, '测试成员', 'OWNER', 'ACTIVE')",
                orgId, deptId, ownerPhone);
        return orgId;
    }

    private String loginOrgMemberInExistingOrg(String phone, long orgId) throws Exception {
        return loginOrgMemberWithTokens(phone, orgId).accessToken();
    }

    /**
     * 认领组织账号并拿该组织的令牌（spec §3.2）。
     *
     * <p>测试里手机号同时充当成员唯一识别 ID。
     */
    private LoginResult loginOrgMemberWithTokens(String phone, long orgId) throws Exception {
        String code = postJson("/api/v1/auth/sms/code", null, "{\"phone\":\"" + phone + "\"}")
                .path("data").path("debugCode").asText();
        String registerToken = postJson("/api/v1/auth/login/sms", null,
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"dev\"}")
                .path("data").path("registerToken").asText();
        String personalToken = postJson("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"成员" + phone.substring(phone.length() - 4) + "\",\"deviceId\":\"dev\"}")
                .path("data").path("accessToken").asText();

        String orgCode = jdbcTemplate.queryForObject(
                "SELECT code FROM organization WHERE id = ?", String.class, orgId);
        JsonNode claimed = postJson("/api/v1/org-accounts/login?deviceId=dev", personalToken,
                "{\"org\":\"" + orgCode + "\",\"memberKey\":\"" + phone + "\"}");
        return new LoginResult(claimed.path("data").path("accessToken").asText(),
                claimed.path("data").path("refreshToken").asText());
    }

    private JsonNode getJson(String path, String token) throws Exception {
        MockHttpServletRequestBuilder builder = get(path);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return read(mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private JsonNode postJson(String path, String token, String body) throws Exception {
        MockHttpServletRequestBuilder builder = post(path)
                .contentType(MediaType.APPLICATION_JSON).content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return read(mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private JsonNode putJson(String path, String token, String body) throws Exception {
        MockHttpServletRequestBuilder builder = put(path)
                .contentType(MediaType.APPLICATION_JSON).content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return read(mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private JsonNode read(String body) throws Exception {
        return objectMapper.readTree(body);
    }
}
