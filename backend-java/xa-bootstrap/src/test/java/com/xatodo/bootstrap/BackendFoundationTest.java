package com.xatodo.bootstrap;

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.io.IOException;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 后端地基验收：迁移脚本可执行、表结构完整、统一响应体生效、关键约束生效。
 *
 * <p>使用 zonky 嵌入式 PostgreSQL（免 Docker），与 spec §10.1 的集成测试语义一致。
 */
@SpringBootTest
@AutoConfigureMockMvc
class BackendFoundationTest {

    private static EmbeddedPostgres postgres;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @DynamicPropertySource
    static void datasourceProperties(DynamicPropertyRegistry registry) throws IOException {
        postgres = EmbeddedPostgres.builder().start();
        registry.add("spring.datasource.url", () -> postgres.getJdbcUrl("postgres", "postgres"));
        registry.add("spring.datasource.username", () -> "postgres");
        registry.add("spring.datasource.password", () -> "postgres");
    }

    @AfterAll
    static void stopPostgres() throws IOException {
        if (postgres != null) {
            postgres.close();
        }
    }

    @Test
    @DisplayName("Flyway 迁移全部执行且无失败记录")
    void flywayAppliedAllMigrations() throws Exception {
        // 期望数量直接由 classpath 上的迁移文件推导，避免新增迁移后测试写死数字而失守
        int expected = new PathMatchingResourcePatternResolver()
                .getResources("classpath:db/migration/V*__*.sql").length;
        Integer applied = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE success = true", Integer.class);
        Integer failed = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE success = false", Integer.class);

        assertThat(applied).isEqualTo(expected);
        assertThat(failed).isZero();
    }

    @Test
    @DisplayName("spec §5 定义的表全部创建成功")
    void allSpecTablesExist() {
        List<String> expected = List.of(
                "organization", "admin_user",
                "account", "identity", "login_log",
                "department", "org_member", "department_manager",
                "calendar", "event", "event_exception", "task", "reminder",
                "event_dispatch", "event_recipient",
                "import_batch", "import_row_result", "audit_log", "system_config",
                // spec §5.11 节假日与调休（数据由 scripts/load_holidays.py 灌入，迁移只建表）
                "holiday");

        List<String> actual = jdbcTemplate.queryForList(
                "SELECT table_name FROM information_schema.tables "
                        + "WHERE table_schema = 'public' AND table_name <> 'flyway_schema_history'",
                String.class);

        assertThat(actual).containsExactlyInAnyOrderElementsOf(expected);
    }

    @Test
    @DisplayName("系统探活接口返回统一响应体且携带 traceId")
    void systemInfoReturnsUnifiedEnvelope() throws Exception {
        mockMvc.perform(get("/api/v1/system/info"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.message").value("ok"))
                .andExpect(jsonPath("$.data.name").value("xa-todo-backend"))
                .andExpect(jsonPath("$.traceId").isNotEmpty());
    }

    @Test
    @DisplayName("未认证访问受保护接口返回 401 且响应体结构一致")
    void unauthenticatedRequestReturnsEnvelope() throws Exception {
        mockMvc.perform(get("/api/v1/calendars"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value(20001))
                .andExpect(jsonPath("$.traceId").isNotEmpty());
    }

    @Test
    @DisplayName("同一组织只允许存在一个拥有者（spec §2.1）")
    void onlyOneOwnerPerOrganization() {
        long orgId = insertOrganization("心安科技", "XAKJ");
        long departmentId = insertDepartment(orgId);
        long firstMember = insertMember(orgId, departmentId, "13800000001", "张三", "OWNER");
        long secondIdentity = createOrgIdentity("13800000002", orgId);

        assertThat(firstMember).isPositive();
        assertThatThrownBy(() -> jdbcTemplate.update(
                "INSERT INTO org_member (org_id, identity_id, department_id, real_name, org_role) "
                        + "VALUES (?, ?, ?, ?, 'OWNER')",
                orgId, secondIdentity, departmentId, "李四"))
                .isInstanceOf(DataAccessException.class);
    }

    @Test
    @DisplayName("日程结束时间必须晚于开始时间（spec §5.5）")
    void eventEndMustBeAfterStart() {
        long orgId = insertOrganization("心安科技", "XAKJ2");
        long departmentId = insertDepartment(orgId);
        long identityId = createOrgIdentity("13800000003", orgId);
        Long calendarId = jdbcTemplate.queryForObject(
                "INSERT INTO calendar (calendar_type, org_id, name) VALUES ('ORG', ?, '组织日历') RETURNING id",
                Long.class, orgId);

        assertThatThrownBy(() -> jdbcTemplate.update(
                "INSERT INTO event (calendar_id, org_id, creator_identity_id, title, start_at, end_at) "
                        + "VALUES (?, ?, ?, '倒置日程', TIMESTAMPTZ '2026-10-08 11:00:00+08', TIMESTAMPTZ '2026-10-08 09:00:00+08')",
                calendarId, orgId, identityId))
                .isInstanceOf(DataAccessException.class);
    }

    private long insertOrganization(String name, String code) {
        return jdbcTemplate.queryForObject(
                "INSERT INTO organization (name, code) VALUES (?, ?) RETURNING id",
                Long.class, name, code);
    }

    private long insertDepartment(long orgId) {
        long departmentId = jdbcTemplate.queryForObject(
                "INSERT INTO department (org_id, name, path, level) VALUES (?, '总部', '/0/', 1) RETURNING id",
                Long.class, orgId);
        // path 依赖自身 id，插入后补齐为物化路径 /{id}/
        jdbcTemplate.update("UPDATE department SET path = '/' || id || '/' WHERE id = ?", departmentId);
        return departmentId;
    }

    private long createOrgIdentity(String phone, long orgId) {
        long accountId = jdbcTemplate.queryForObject(
                "INSERT INTO account (phone) VALUES (?) RETURNING id", Long.class, phone);
        return jdbcTemplate.queryForObject(
                "INSERT INTO identity (account_id, identity_type, org_id, nickname) "
                        + "VALUES (?, 'ORG_MEMBER', ?, ?) RETURNING id",
                Long.class, accountId, orgId, phone);
    }

    private long insertMember(long orgId, long departmentId, String phone, String realName, String role) {
        long identityId = createOrgIdentity(phone, orgId);
        return jdbcTemplate.queryForObject(
                "INSERT INTO org_member (org_id, identity_id, department_id, real_name, org_role) "
                        + "VALUES (?, ?, ?, ?, ?) RETURNING id",
                Long.class, orgId, identityId, departmentId, realName, role);
    }
}
