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
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\"}");
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
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\"}")
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
                        .content("{\"phone\":\"" + phone + "\",\"code\":\"000000\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20006));

        Integer accounts = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM account WHERE phone = ?", Integer.class, phone);
        assertThat(accounts).isZero();
    }

    @Test
    @DisplayName("同一账号持有个人与组织身份时，登录返回身份列表并可切换到组织身份")
    void switchBetweenPersonalAndOrgIdentity() throws Exception {
        String phone = "13800000104";
        String code = requestSmsCode(phone);
        String registerToken = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\"}")
                .path("data").path("registerToken").asText();
        JsonNode personal = postJsonWithBearer("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"双身份用户\",\"deviceId\":\"device-1\"}");
        long accountId = personal.path("data").path("identity").path("accountId").asLong();
        long personalIdentityId = personal.path("data").path("identity").path("identityId").asLong();

        long orgIdentityId = seedOrgIdentity(accountId, "XAKJ104");

        // 再次登录：复用同一账号，直接向 Redis 注入验证码以避开 60 秒发送频控
        injectCode(phone, "123456");
        JsonNode login = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"123456\"}");
        assertThat(login.path("data").path("needSelectIdentity").asBoolean()).isTrue();
        assertThat(login.path("data").path("identities")).hasSize(2);
        String selectToken = login.path("data").path("selectToken").asText();

        JsonNode switched = postJson("/api/v1/auth/identity/select",
                "{\"selectToken\":\"" + selectToken + "\",\"identityId\":" + orgIdentityId
                        + ",\"deviceId\":\"device-1\"}");
        assertThat(switched.path("data").path("identity").path("orgId").asLong()).isPositive();
        String orgAccessToken = switched.path("data").path("accessToken").asText();

        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + orgAccessToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.identityType").value("ORG_MEMBER"))
                .andExpect(jsonPath("$.data.orgName").value("心安科技"));

        // 切换到不属于本账号的身份必须被拒绝
        long otherIdentityId = seedForeignIdentity();
        mockMvc.perform(post("/api/v1/auth/identity/switch")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\""
                                + switched.path("data").path("refreshToken").asText()
                                + "\",\"targetIdentityId\":" + otherIdentityId + "}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20009));

        assertThat(personalIdentityId).isPositive();
    }

    @Test
    @DisplayName("刷新令牌轮换：旧刷新令牌立即失效，登出后同样失效")
    void refreshTokenRotationAndLogout() throws Exception {
        String phone = "13800000105";
        String code = requestSmsCode(phone);
        String registerToken = postJson("/api/v1/auth/login/sms",
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\"}")
                .path("data").path("registerToken").asText();
        String refreshToken = postJsonWithBearer("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"轮换用户\",\"deviceId\":\"device-1\"}")
                .path("data").path("refreshToken").asText();

        JsonNode refreshed = postJson("/api/v1/auth/token/refresh",
                "{\"refreshToken\":\"" + refreshToken + "\",\"deviceId\":\"device-1\"}");
        String newRefreshToken = refreshed.path("data").path("refreshToken").asText();
        assertThat(newRefreshToken).isNotBlank().isNotEqualTo(refreshToken);

        mockMvc.perform(post("/api/v1/auth/token/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20007));

        mockMvc.perform(post("/api/v1/auth/logout")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + newRefreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));

        mockMvc.perform(post("/api/v1/auth/token/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + newRefreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20007));
    }

    // ---------------------------------------------------------------- helpers

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

    private long seedOrgIdentity(long accountId, String orgCode) {
        Long orgId = jdbcTemplate.queryForObject(
                "INSERT INTO organization (name, code) VALUES ('心安科技', ?) RETURNING id",
                Long.class, orgCode);
        long departmentId = insertDepartment(orgId);
        Long identityId = jdbcTemplate.queryForObject(
                "INSERT INTO identity (account_id, identity_type, org_id, nickname) "
                        + "VALUES (?, 'ORG_MEMBER', ?, '员工小张') RETURNING id",
                Long.class, accountId, orgId);
        jdbcTemplate.update(
                "INSERT INTO org_member (org_id, identity_id, department_id, real_name, org_role, member_no) "
                        + "VALUES (?, ?, ?, '张三', 'MEMBER', ?)",
                orgId, identityId, departmentId, "E" + orgCode);
        return identityId;
    }

    private long seedForeignIdentity() {
        Long otherAccountId = jdbcTemplate.queryForObject(
                "INSERT INTO account (phone) VALUES ('13900000200') RETURNING id", Long.class);
        return seedOrgIdentity(otherAccountId, "XAKJ200");
    }

    private long insertDepartment(Long orgId) {
        Long departmentId = jdbcTemplate.queryForObject(
                "INSERT INTO department (org_id, name, path, level) VALUES (?, '总部', '/0/', 1) RETURNING id",
                Long.class, orgId);
        jdbcTemplate.update("UPDATE department SET path = '/' || id || '/' WHERE id = ?", departmentId);
        return departmentId;
    }
}
