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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.net.ServerSocket;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 认证链路端到端验收（spec §3.2、§10.1 必测场景 1/2/9）。
 *
 * <p>真实依赖：嵌入式 PostgreSQL 执行迁移 + 嵌入式 Redis 承载验证码与刷新令牌。
 */
@SpringBootTest
@AutoConfigureMockMvc
class AuthFlowTest {

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;
    private static int redisPort;

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
        redisPort = findFreePort();
        redisServer = RedisServer.newRedisServer().port(redisPort).build();
        redisServer.start();

        registry.add("spring.datasource.url", () -> postgres.getJdbcUrl("postgres", "postgres"));
        registry.add("spring.datasource.username", () -> "postgres");
        registry.add("spring.datasource.password", () -> "postgres");
        registry.add("spring.data.redis.port", () -> redisPort);
        registry.add("xatodo.auth.expose-sms-code", () -> true);
        // 缩短轮换宽限期，便于验证宽限期过期后的行为
        registry.add("xatodo.auth.refresh-rotation-grace", () -> "1s");
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
    @DisplayName("未携带令牌访问受保护接口返回 401 与统一响应体")
    void unauthenticatedRequestRejected() throws Exception {
        mockMvc.perform(get("/api/v1/me"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value(20001))
                .andExpect(jsonPath("$.traceId").isNotEmpty());
    }

    @Test
    @DisplayName("首次登录走注册引导，创建个人身份后可访问 /me 与身份列表")
    void firstLoginRegistersPersonalIdentity() throws Exception {
        String phone = "13800000101";
        String code = requestSmsCode(phone);

        JsonNode login = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"device-1\"}");
        assertThat(login.path("data").path("needRegister").asBoolean()).isTrue();
        String registerToken = login.path("data").path("registerToken").asText();
        assertThat(registerToken).isNotBlank();

        JsonNode created = postJsonWithBearer("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"小明\",\"deviceId\":\"device-1\"}");
        String accessToken = created.path("data").path("accessToken").asText();
        assertThat(created.path("data").path("identity").path("identityType").asText()).isEqualTo("PERSONAL");
        assertThat(accessToken).isNotBlank();

        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + accessToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.nickname").value("小明"))
                .andExpect(jsonPath("$.data.identityType").value("PERSONAL"));

        JsonNode identities = getJsonWithBearer("/api/v1/auth/identities", accessToken);
        assertThat(identities.path("data")).hasSize(1);
    }

    @Test
    @DisplayName("未选定身份时注册令牌不能访问业务接口")
    void registerTokenCannotAccessBusinessApi() throws Exception {
        String phone = "13800000107";
        String code = requestSmsCode(phone);
        String registerToken = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"device-1\"}")
                .path("data").path("registerToken").asText();

        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + registerToken))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value(20001));
    }

    @Test
    @DisplayName("同手机号 60 秒内重复发送验证码被频控拦截")
    void smsSendRateLimited() throws Exception {
        String phone = "13800000102";
        requestSmsCode(phone);

        mockMvc.perform(post("/api/v1/auth/sms/code")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20005));
    }

    @Test
    @DisplayName("验证码错误返回 20006，且账号不会被创建")
    void wrongCodeRejected() throws Exception {
        String phone = "13800000103";
        requestSmsCode(phone);

        mockMvc.perform(post("/api/v1/auth/login/sms")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\",\"code\":\"000000\",\"deviceId\":\"device-1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20006));

        Integer accounts = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM account WHERE phone = ?", Integer.class, phone);
        assertThat(accounts).isZero();
    }

    @Test
    @DisplayName("登录只认个人账号；组织身份靠「认领组织账号」产生（spec §3.1 / §3.2）")
    void loginReturnsPersonalSessionAndOrgIdentityComesFromClaiming() throws Exception {
        String phone = "13800000104";
        JsonNode personal = registerAccountWithPersonalIdentity(phone, "双身份用户");
        String personalToken = personal.path("data").path("accessToken").asText();

        // 管理员先导入成员记录（未认领），成员自己用「组织唯一 ID + 成员标识」认领
        seedOrgWithUnclaimedMember("XAKJ104", "S1001");
        JsonNode claimed = postJsonWithBearer("/api/v1/org-accounts/login?deviceId=device-1", personalToken,
                "{\"org\":\"XAKJ104\",\"memberKey\":\"S1001\"}");
        assertThat(claimed.path("data").path("account").path("orgName").asText()).isEqualTo("心安科技");
        String orgAccessToken = claimed.path("data").path("accessToken").asText();

        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + orgAccessToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.identityType").value("ORG_MEMBER"))
                .andExpect(jsonPath("$.data.orgName").value("心安科技"));

        // 再次登录：依旧只登录个人账号，不再有「选身份」这一步
        injectCode(phone, "123456");
        JsonNode login = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"123456\",\"deviceId\":\"device-2\"}");
        assertThat(login.path("data").path("needRegister").asBoolean()).isFalse();
        assertThat(login.path("data").path("session").path("identity").path("identityType").asText())
                .isEqualTo("PERSONAL");
        assertThat(login.path("data").path("selectToken").isMissingNode())
                .as("已经不再需要 selectToken").isTrue();

        // 认领过的组织账号出现在「我的组织账号」里
        JsonNode accounts = getJsonWithBearer("/api/v1/org-accounts", personalToken);
        assertThat(accounts.path("data")).hasSize(1);
        assertThat(accounts.path("data").get(0).path("memberKey").asText()).isEqualTo("S1001");

        // 切换到不属于本账号的身份仍然必须被拒绝
        long otherIdentityId = seedForeignIdentity();
        mockMvc.perform(post("/api/v1/auth/identity/switch")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\""
                                + personal.path("data").path("refreshToken").asText()
                                + "\",\"targetIdentityId\":" + otherIdentityId + "}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20009));
    }

    @Test
    @DisplayName("并发刷新不踢人：宽限期内重复提交旧令牌，取回同一个新令牌")
    void concurrentRefreshWithinGraceIsIdempotent() throws Exception {
        String phone = "13800000105";
        String refreshToken = registerAccountWithPersonalIdentity(phone, "轮换用户")
                .path("data").path("refreshToken").asText();

        JsonNode first = postJson("/api/v1/auth/token/refresh",
                "{\"refreshToken\":\"" + refreshToken + "\",\"deviceId\":\"device-1\"}");
        String rotated = first.path("data").path("refreshToken").asText();
        assertThat(rotated).isNotBlank().isNotEqualTo(refreshToken);

        // App 并发提交同一个旧令牌：应当成功并拿回同一个新令牌，而不是被判定失效
        JsonNode second = postJson("/api/v1/auth/token/refresh",
                "{\"refreshToken\":\"" + refreshToken + "\",\"deviceId\":\"device-1\"}");
        assertThat(second.path("code").asInt()).isZero();
        assertThat(second.path("data").path("refreshToken").asText()).isEqualTo(rotated);
        assertThat(second.path("data").path("accessToken").asText()).isNotBlank();
    }

    @Test
    @DisplayName("登出后刷新令牌立即失效")
    void logoutRevokesRefreshToken() throws Exception {
        String phone = "13800000109";
        String refreshToken = registerAccountWithPersonalIdentity(phone, "登出用户")
                .path("data").path("refreshToken").asText();

        postJson("/api/v1/auth/logout", "{\"refreshToken\":\"" + refreshToken + "\"}");

        mockMvc.perform(post("/api/v1/auth/token/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20007));
    }

    @Test
    @DisplayName("轮换宽限期过期后，被替换的旧刷新令牌不再可用")
    void rotatedTokenRejectedAfterGraceWindow() throws Exception {
        String phone = "13800000110";
        String refreshToken = registerAccountWithPersonalIdentity(phone, "宽限用户")
                .path("data").path("refreshToken").asText();

        postJson("/api/v1/auth/token/refresh",
                "{\"refreshToken\":\"" + refreshToken + "\",\"deviceId\":\"device-1\"}");

        Thread.sleep(1300L);

        mockMvc.perform(post("/api/v1/auth/token/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20007));
    }

    @Test
    @DisplayName("账号被停用后刷新要求重新登录，且全部刷新令牌被吊销")
    void disabledAccountForcesReLogin() throws Exception {
        String phone = "13800000108";
        String refreshToken = registerAccountWithPersonalIdentity(phone, "停用用户")
                .path("data").path("refreshToken").asText();

        jdbcTemplate.update("UPDATE account SET status = 'DISABLED' WHERE phone = ?", phone);

        mockMvc.perform(post("/api/v1/auth/token/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20008));

        Integer identities = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM identity WHERE account_id = "
                        + "(SELECT id FROM account WHERE phone = ?)", Integer.class, phone);
        assertThat(identities).isPositive();

        // 账号停用同时吊销全部刷新令牌
        mockMvc.perform(post("/api/v1/auth/token/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20007));
    }

    // ---------------------------------------------------------------- helpers

    @Test
    @DisplayName("账号设置：修改资料、设置密码、密码登录、设备查看与踢出")
    void profilePasswordAndDevices() throws Exception {
        String phone = "13800000120";
        String refreshToken = registerAccountWithPersonalIdentity(phone, "设置用户")
                .path("data").path("refreshToken").asText();
        // 重新登录拿一个带 deviceId 的会话，便于验证设备列表
        injectCode(phone, "246810");
        // 登录直接签发个人身份的令牌（spec §3.2），deviceId 就是这台设备
        JsonNode session = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"246810\",\"deviceId\":\"device-A\"}")
                .path("data").path("session");
        String accessToken = session.path("accessToken").asText();
        String sessionRefreshToken = session.path("refreshToken").asText();

        // 修改资料
        JsonNode updated = patchJson("/api/v1/me", accessToken,
                "{\"nickname\":\"新昵称\",\"timezone\":\"Asia/Shanghai\"}");
        assertThat(updated.path("data").path("nickname").asText()).isEqualTo("新昵称");
        assertThat(updated.path("data").path("timezone").asText()).isEqualTo("Asia/Shanghai");

        // 首次设置密码无需原密码
        putJson("/api/v1/me/password", accessToken, "{\"newPassword\":\"mySecret123\"}");

        // 已设置密码后，不带原密码应被拒绝
        mockMvc.perform(put("/api/v1/me/password")
                        .header("Authorization", "Bearer " + accessToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"newPassword\":\"anotherPass123\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(10002));

        // 用新密码登录：同样只认个人身份，直接给出个人身份的令牌对
        JsonNode passwordLogin = postJson("/api/v1/auth/login/password",
                "{\"phone\":\"" + phone + "\",\"password\":\"mySecret123\",\"deviceId\":\"device-A\"}");
        assertThat(passwordLogin.path("data").path("needRegister").asBoolean()).isFalse();
        assertThat(passwordLogin.path("data").path("session").path("identity").path("identityType").asText())
                .isEqualTo("PERSONAL");

        // 错误密码返回 20011
        mockMvc.perform(post("/api/v1/auth/login/password")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\",\"password\":\"wrong-password\","
                                + "\"deviceId\":\"device-A\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20011));

        // 设备列表包含刚登录的设备
        JsonNode devices = getJsonWithBearer("/api/v1/me/devices", accessToken);
        // device-1（注册时）、device-A（短信登录 + 密码登录各一次）
        assertThat(devices.path("data")).hasSize(3);
        assertThat(devices.path("data").get(0).path("deviceId").asText()).isNotBlank();

        // 踢出 device-A 后其刷新令牌立即失效
        mockMvc.perform(delete("/api/v1/me/devices/device-A")
                        .header("Authorization", "Bearer " + accessToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));
        mockMvc.perform(post("/api/v1/auth/token/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + sessionRefreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20007));
        assertThat(refreshToken).isNotBlank();
    }

    @Test
    @DisplayName("通知偏好可整体覆盖保存")
    void notificationPreferences() throws Exception {
        String phone = "13800000121";
        String token = registerAccountWithPersonalIdentity(phone, "偏好用户")
                .path("data").path("accessToken").asText();

        JsonNode saved = putJson("/api/v1/me/notifications", token,
                "{\"prefs\":{\"eventReminder\":false,\"orgDispatch\":true}}");
        assertThat(saved.path("data").path("eventReminder").asBoolean()).isFalse();
        assertThat(saved.path("data").path("orgDispatch").asBoolean()).isTrue();
    }

    private JsonNode putJson(String path, String token, String body) throws Exception {
        var builder = org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(path)
                .contentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        if (body != null) {
            builder.content(body);
        }
        String response = mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
    }

    private JsonNode patchJson(String path, String token, String body) throws Exception {
        var builder = patch(path).contentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        if (body != null) {
            builder.content(body);
        }
        String response = mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
    }

    private String requestSmsCode(String phone) throws Exception {
        JsonNode response = postJson("/api/v1/auth/sms/code", "{\"phone\":\"" + phone + "\"}");
        assertThat(response.path("code").asInt()).isZero();
        String debugCode = response.path("data").path("debugCode").asText();
        assertThat(debugCode).hasSize(6);
        return debugCode;
    }

    private void injectCode(String phone, String code) {
        redisTemplate.opsForValue().set("sms:code:" + phone, code, Duration.ofMinutes(5));
    }

    private JsonNode registerAccountWithPersonalIdentity(String phone, String nickname) throws Exception {
        String code = requestSmsCode(phone);
        String registerToken = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"device-1\"}")
                .path("data").path("registerToken").asText();
        return postJsonWithBearer("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"" + nickname + "\",\"deviceId\":\"device-1\"}");
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

    /**
     * 造一个「管理员刚导入、还没人认领」的成员（spec §3.1）。
     *
     * <p>刻意不建身份：身份要等成员自己用「组织唯一 ID + 成员标识」认领时才产生。
     */
    private void seedOrgWithUnclaimedMember(String orgCode, String memberKey) {
        Long orgId = jdbcTemplate.queryForObject(
                "INSERT INTO organization (name, code) VALUES ('心安科技', ?) RETURNING id",
                Long.class, orgCode);
        long departmentId = insertDepartment(orgId);
        jdbcTemplate.update(
                "INSERT INTO org_member (org_id, department_id, member_key, real_name, org_role, status) "
                        + "VALUES (?, ?, ?, '张三', 'MEMBER', 'ACTIVE')",
                orgId, departmentId, memberKey);
    }

    private long seedForeignIdentity() {
        Long otherAccountId = jdbcTemplate.queryForObject(
                "INSERT INTO account (phone) VALUES ('13900000200') RETURNING id", Long.class);
        Long orgId = jdbcTemplate.queryForObject(
                "INSERT INTO organization (name, code) VALUES ('别人家的公司', 'XAKJ200') RETURNING id",
                Long.class);
        long departmentId = insertDepartment(orgId);
        return jdbcTemplate.queryForObject(
                "INSERT INTO identity (account_id, identity_type, org_id, nickname) "
                        + "VALUES (?, 'ORG_MEMBER', ?, '别人的身份') RETURNING id",
                Long.class, otherAccountId, orgId);
    }

    private long insertDepartment(Long orgId) {
        Long departmentId = jdbcTemplate.queryForObject(
                "INSERT INTO department (org_id, name, path, level) VALUES (?, '总部', '/0/', 1) RETURNING id",
                Long.class, orgId);
        jdbcTemplate.update("UPDATE department SET path = '/' || id || '/' WHERE id = ?", departmentId);
        return departmentId;
    }
}
