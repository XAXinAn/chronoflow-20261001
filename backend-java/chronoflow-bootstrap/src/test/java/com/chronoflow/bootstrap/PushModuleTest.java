package com.chronoflow.bootstrap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.support.push.PushProvider;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
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
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 推送链路（spec §4.5）。
 *
 * <p>用记录型 {@link PushProvider} 替换极光实现：这里要验证的是**服务端有没有在对的时机、
 * 把对的设备交给通道**，而不是极光能不能收（那要靠真机 + 极光后台）。
 */
@SpringBootTest
@AutoConfigureMockMvc
class PushModuleTest {

    /** 记录每次推送的收件设备与内容，测试里断言它。 */
    static final class RecordingPushProvider implements PushProvider {

        final List<List<String>> calls = new ArrayList<>();
        final List<PushNotification> notifications = new ArrayList<>();

        @Override
        public String name() {
            return "recording";
        }

        @Override
        public boolean configured() {
            return true;
        }

        @Override
        public PushOutcome send(List<String> registrationIds, PushNotification notification) {
            calls.add(List.copyOf(registrationIds));
            notifications.add(notification);
            return new PushOutcome(registrationIds.size(), List.of(), null);
        }
    }

    @TestConfiguration
    static class RecordingConfig {

        @Bean
        @Primary
        RecordingPushProvider recordingPushProvider() {
            return new RecordingPushProvider();
        }
    }

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

    @Autowired
    private RecordingPushProvider pushProvider;

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
    @DisplayName("上报推送设备后，组织日程下发会把通知发到这台设备")
    void dispatchNotifiesRegisteredDevice() throws Exception {
        // 一个账号 + 一个组织拥有者成员（沿用「成员先导入、成员自己认领」的模型）
        JsonNode personal = registerAccountWithPersonalIdentity("13800000501", "拥有者");
        String personalToken = personal.path("data").path("accessToken").asText();

        long orgId = seedOrgWithOwnerMember("PUSHORG501", "O5001");

        // App 在设备上初始化推送 SDK 后上报 registrationId（身份是**个人**身份）
        mockMvc.perform(post("/api/v1/me/push-devices")
                        .header("Authorization", "Bearer " + personalToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"registrationId\":\"reg-abc-001\",\"platform\":\"android\",\"appVersion\":\"0.1.0\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.registrationId").value("reg-abc-001"));

        // 认领组织账号，拿到组织身份令牌
        String orgToken = postJsonWithBearer("/api/v1/org-accounts/login?deviceId=device-1", personalToken,
                "{\"org\":\"PUSHORG501\",\"memberKey\":\"O5001\"}").path("data").path("accessToken").asText();

        // 下发组织日程给自己（发起人也在收件名单里，见 spec §4.2.2）
        long memberId = jdbcTemplate.queryForObject(
                "SELECT id FROM org_member WHERE org_id = ?", Long.class, orgId);
        postJsonWithBearer("/api/v1/org-admin/events", orgToken,
                "{\"title\":\"周二例会\",\"at\":\"2026-10-06T01:00:00Z\","
                        + "\"scopeType\":\"MEMBER\","
                        + "\"memberIds\":[" + memberId + "],\"includeSubDepartments\":false}");

        // 关键断言：设备是按**账号**找到的 —— 上报时用的是个人身份，
        // 而收件人是同一个人的组织身份。按身份查会一条都命中不了（实现过程中踩过这个坑）。
        assertThat(pushProvider.calls).as("应当恰好推送一次").hasSize(1);
        assertThat(pushProvider.calls.get(0)).containsExactly("reg-abc-001");
        PushProvider.PushNotification sent = pushProvider.notifications.get(0);
        assertThat(sent.title()).isEqualTo("周二例会");
        assertThat(sent.extras()).containsEntry("type", "ORG_EVENT");
    }

    @Test
    @DisplayName("没上报任何设备时不推送，且不影响下发本身")
    void dispatchWithoutDeviceStillSucceeds() throws Exception {
        JsonNode personal = registerAccountWithPersonalIdentity("13800000502", "无设备用户");
        String personalToken = personal.path("data").path("accessToken").asText();

        long orgId = seedOrgWithOwnerMember("PUSHORG502", "O5002");
        String orgToken = postJsonWithBearer("/api/v1/org-accounts/login?deviceId=device-1", personalToken,
                "{\"org\":\"PUSHORG502\",\"memberKey\":\"O5002\"}").path("data").path("accessToken").asText();
        long memberId = jdbcTemplate.queryForObject(
                "SELECT id FROM org_member WHERE org_id = ?", Long.class, orgId);

        int before = pushProvider.calls.size();
        postJsonWithBearer("/api/v1/org-admin/events", orgToken,
                "{\"title\":\"无人收到\",\"at\":\"2026-10-07T01:00:00Z\","
                        + "\"scopeType\":\"MEMBER\","
                        + "\"memberIds\":[" + memberId + "],\"includeSubDepartments\":false}");
        assertThat(pushProvider.calls).as("没有设备就不该调通道").hasSize(before);
    }

    // ---------------------------------------------------------------- helpers

    private long seedOrgWithOwnerMember(String orgCode, String memberKey) {
        Long orgId = jdbcTemplate.queryForObject(
                "INSERT INTO organization (name, code) VALUES ('推送测试组织', ?) RETURNING id",
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

    private JsonNode registerAccountWithPersonalIdentity(String phone, String nickname) throws Exception {
        String code = postJson("/api/v1/auth/sms/code", "{\"phone\":\"" + phone + "\"}")
                .path("data").path("debugCode").asText();
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
}
