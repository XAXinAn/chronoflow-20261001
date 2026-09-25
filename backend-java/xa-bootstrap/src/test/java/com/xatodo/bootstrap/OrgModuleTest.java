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
import org.springframework.mock.web.MockMultipartFile;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 组织模块端到端验收，覆盖 spec §10.1 必测场景 4、5 与 §2.2 权限矩阵的关键格子。
 */
@SpringBootTest
@AutoConfigureMockMvc
class OrgModuleTest {

    private static final String RANGE_START = "2026-10-01T00:00:00+08:00";
    private static final String RANGE_END = "2026-11-01T00:00:00+08:00";

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
    @DisplayName("组织上下文返回成员角色与可管理部门集合")
    void currentReturnsRoleAndManageableDepartments() throws Exception {
        Fixture fixture = seedOrg("CUR", "13700001101");

        JsonNode current = getJson("/api/v1/org/current", fixture.ownerToken());
        assertThat(current.path("data").path("orgName").asText()).isEqualTo("测试组织CUR");
        assertThat(current.path("data").path("orgRole").asText()).isEqualTo("OWNER");
        assertThat(current.path("data").path("orgAdmin").asBoolean()).isTrue();
        assertThat(current.path("data").path("departmentPathNames").get(0).asText()).isEqualTo("总部");
    }

    @Test
    @DisplayName("部门树最多 5 层，第 6 层被拒绝")
    void departmentTreeLimitedToFiveLevels() throws Exception {
        Fixture fixture = seedOrg("LVL", "13700001102");

        long parentId = fixture.rootDepartmentId();
        for (int level = 2; level <= 5; level++) {
            JsonNode created = postJson("/api/v1/org-admin/departments", fixture.ownerToken(),
                    "{\"parentId\":" + parentId + ",\"name\":\"L" + level + "\"}");
            parentId = created.path("data").path("id").asLong();
            assertThat(created.path("data").path("level").asInt()).isEqualTo(level);
        }

        mockMvc.perform(post("/api/v1/org-admin/departments")
                        .header("Authorization", "Bearer " + fixture.ownerToken())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"parentId\":" + parentId + ",\"name\":\"L6\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(40001));

        JsonNode tree = getJson("/api/v1/org/departments/tree", fixture.ownerToken());
        assertThat(tree.path("data")).hasSize(1);
        assertThat(depth(tree.path("data").get(0))).isEqualTo(5);
    }

    @Test
    @DisplayName("部门管理员的权限范围是「本部门 + 所有下级」，不含兄弟部门")
    void departmentManagerScopeIsRecursive() throws Exception {
        Fixture fixture = seedOrg("SCOPE", "13700001103");
        long techId = createDepartment(fixture, fixture.rootDepartmentId(), "技术中心");
        long backendId = createDepartment(fixture, techId, "后端组");
        long marketId = createDepartment(fixture, fixture.rootDepartmentId(), "市场部");

        long techAdminMemberId = createMember(fixture, "13700001104", "技术负责人", techId);
        grantManager(fixture, techId, techAdminMemberId);
        createMember(fixture, "13700001105", "后端同学", backendId);
        createMember(fixture, "13700001106", "市场同学", marketId);

        String techAdminToken = claimOrgAccount(fixture.orgCode(), "13700001104");
        JsonNode current = getJson("/api/v1/org/current", techAdminToken);
        assertThat(current.path("data").path("orgAdmin").asBoolean()).isFalse();
        assertThat(current.path("data").path("manageableDepartmentIds"))
                .hasSize(2);   // 技术中心 + 后端组

        JsonNode visible = getJson("/api/v1/org-admin/members", techAdminToken);
        assertThat(names(visible.path("data")))
                .containsExactlyInAnyOrder("技术负责人", "后端同学");

        // 部门管理员可以向本部门及下级下发
        JsonNode dispatched = postJson("/api/v1/org-admin/events", techAdminToken,
                dispatchBody("技术中心周会", "DEPARTMENT", techId, true, null));
        assertThat(dispatched.path("code").asInt()).isZero();

        // 但不能向兄弟部门下发
        mockMvc.perform(post("/api/v1/org-admin/events")
                        .header("Authorization", "Bearer " + techAdminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dispatchBody("市场部会议", "DEPARTMENT", marketId, true, null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));
    }

    @Test
    @DisplayName("全员下发仅组织管理员可执行")
    void dispatchToAllRequiresOrgAdmin() throws Exception {
        Fixture fixture = seedOrg("ALL", "13700001107");
        long deptId = createDepartment(fixture, fixture.rootDepartmentId(), "研发部");
        long deptAdminMemberId = createMember(fixture, "13700001108", "研发负责人", deptId);
        grantManager(fixture, deptId, deptAdminMemberId);
        String deptAdminToken = claimOrgAccount(fixture.orgCode(), "13700001108");

        mockMvc.perform(post("/api/v1/org-admin/events")
                        .header("Authorization", "Bearer " + deptAdminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dispatchBody("全员大会", "ALL", null, true, null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));

        JsonNode ok = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("全员大会", "ALL", null, true, null));
        assertThat(ok.path("code").asInt()).isZero();
    }

    @Test
    @DisplayName("下发到部门：成员只看到自己的日程并可提交回执，管理员查看回执统计")
    void dispatchToDepartmentAndMemberReceipt() throws Exception {
        Fixture fixture = seedOrg("DISP", "13700001109");
        long deptId = createDepartment(fixture, fixture.rootDepartmentId(), "产品部");
        createMember(fixture, "13700001110", "产品同学A", deptId);
        createMember(fixture, "13700001111", "产品同学B", deptId);

        JsonNode dispatched = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("产品评审", "DEPARTMENT", deptId, true, null));
        long eventId = dispatched.path("data").path("eventId").asLong();
        // 下发响应不含成员侧回执字段（null 字段被 non_null 策略省略），因此断言为 missing
        assertThat(eventId).isPositive();
        assertThat(dispatched.path("data").path("receiptStatus").isMissingNode()).isTrue();

        String memberToken = claimOrgAccount(fixture.orgCode(), "13700001110");
        JsonNode events = rangeQuery("/api/v1/org/events", memberToken);
        assertThat(events.path("data")).hasSize(1);
        assertThat(events.path("data").get(0).path("title").asText()).isEqualTo("产品评审");
        assertThat(events.path("data").get(0).path("receiptStatus").asText()).isEqualTo("PENDING");

        JsonNode receipt = postJson("/api/v1/org/events/" + eventId + "/receipt", memberToken,
                "{\"status\":\"ACCEPTED\",\"remark\":\"准时参加\"}");
        assertThat(receipt.path("data").path("receiptStatus").asText()).isEqualTo("ACCEPTED");

        JsonNode summary = getJson("/api/v1/org-admin/events/" + eventId + "/receipts", fixture.ownerToken());
        assertThat(summary.path("data").path("total").asInt()).isEqualTo(2);
        assertThat(summary.path("data").path("accepted").asInt()).isEqualTo(1);
        assertThat(summary.path("data").path("pending").asInt()).isEqualTo(1);
        assertThat(summary.path("data").path("items")).hasSize(2);
    }

    @Test
    @DisplayName("成员无法创建组织日程，也无法读取他人的回执统计")
    void memberCannotDispatchOrInspectOthers() throws Exception {
        Fixture fixture = seedOrg("DENY", "13700001112");
        long deptA = createDepartment(fixture, fixture.rootDepartmentId(), "A部");
        long deptB = createDepartment(fixture, fixture.rootDepartmentId(), "B部");
        createMember(fixture, "13700001113", "A部同学", deptA);
        createMember(fixture, "13700001114", "B部同学", deptB);

        String memberToken = claimOrgAccount(fixture.orgCode(), "13700001113");

        mockMvc.perform(post("/api/v1/org-admin/events")
                        .header("Authorization", "Bearer " + memberToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dispatchBody("自建日程", "ALL", null, true, null)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));

        JsonNode dispatched = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("B部专属会议", "DEPARTMENT", deptB, false, null));
        long eventId = dispatched.path("data").path("eventId").asLong();

        mockMvc.perform(get("/api/v1/org-admin/events/" + eventId + "/receipts")
                        .header("Authorization", "Bearer " + memberToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));

        // A 部成员看不到下发给 B 部的日程
        JsonNode aEvents = rangeQuery("/api/v1/org/events", memberToken);
        assertThat(aEvents.path("data")).isEmpty();

        // 也不能替未下发到的日程提交回执
        mockMvc.perform(post("/api/v1/org/events/" + eventId + "/receipt")
                        .header("Authorization", "Bearer " + memberToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"ACCEPTED\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(20003));
    }

    @Test
    @DisplayName("下发是快照：下发后新入组的成员不会收到历史日程")
    void newMemberDoesNotReceiveHistoricalDispatch() throws Exception {
        Fixture fixture = seedOrg("SNAP", "13700001115");
        createMember(fixture, "13700001116", "老成员", fixture.rootDepartmentId());

        postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("历史全员会", "ALL", null, true, null));

        createMember(fixture, "13700001117", "新成员", fixture.rootDepartmentId());
        String newMemberToken = claimOrgAccount(fixture.orgCode(), "13700001117");

        JsonNode newMemberEvents = rangeQuery("/api/v1/org/events", newMemberToken);
        assertThat(newMemberEvents.path("data")).isEmpty();

        String oldMemberToken = claimOrgAccount(fixture.orgCode(), "13700001116");
        assertThat(rangeQuery("/api/v1/org/events", oldMemberToken).path("data")).hasSize(1);
    }

    @Test
    @DisplayName("已有成员回执后不允许撤回下发")
    void revokeRejectedAfterReceipt() throws Exception {
        Fixture fixture = seedOrg("REV", "13700001118");
        long deptId = createDepartment(fixture, fixture.rootDepartmentId(), "运营部");
        createMember(fixture, "13700001119", "运营同学", deptId);

        JsonNode dispatched = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("运营例会", "DEPARTMENT", deptId, true, null));
        long eventId = dispatched.path("data").path("eventId").asLong();

        // 无人回执时可以撤回
        postJson("/api/v1/org-admin/events/" + eventId + "/revoke", fixture.ownerToken(), "{}");

        // 重新下发一条，成员回执后再撤回应被拒绝
        JsonNode second = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("运营例会2", "DEPARTMENT", deptId, true, null));
        long secondEventId = second.path("data").path("eventId").asLong();
        String memberToken = claimOrgAccount(fixture.orgCode(), "13700001119");
        postJson("/api/v1/org/events/" + secondEventId + "/receipt", memberToken,
                "{\"status\":\"DECLINED\",\"remark\":\"有冲突\"}");

        mockMvc.perform(post("/api/v1/org-admin/events/" + secondEventId + "/revoke")
                        .header("Authorization", "Bearer " + fixture.ownerToken())
                        .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(50002));
    }

    @Test
    @DisplayName("批量导入：成功行入库、失败行逐行回显原因，并可导出失败明细")
    void importMembersFromCsvWithPartialFailure() throws Exception {
        Fixture fixture = seedOrg("IMP", "13700001201");

        String csv = "姓名,成员唯一识别 ID（学号/工号）,部门路径,角色\n"
                + "张三,S2201,总部,MEMBER\n"
                + "李四,S2202,总部,\n"
                + "王五,,总部,\n"
                + "赵六,S2201,总部,\n";

        JsonNode started = uploadMembers(fixture.ownerToken(), "members.csv", csv, false);
        long batchId = started.path("data").path("batchId").asLong();
        JsonNode finished = awaitImport(fixture.ownerToken(), batchId);

        assertThat(finished.path("data").path("status").asText()).isEqualTo("PARTIAL_FAILED");
        assertThat(finished.path("data").path("totalCount").asInt()).isEqualTo(4);
        assertThat(finished.path("data").path("successCount").asInt()).isEqualTo(2);
        assertThat(finished.path("data").path("failCount").asInt()).isEqualTo(2);

        JsonNode rows = finished.path("data").path("rows");
        assertThat(rows).hasSize(4);
        assertThat(rows.get(2).path("status").asText()).isEqualTo("FAILED");
        // 唯一识别 ID 是组织账号的登录凭据，缺了这行没有意义
        assertThat(rows.get(2).path("errorMessage").asText()).contains("唯一识别 ID");
        assertThat(rows.get(3).path("status").asText()).isEqualTo("FAILED");
        assertThat(rows.get(3).path("errorMessage").asText()).contains("已经是本组织成员");

        // 成功行的成员可以认领组织账号并读到自己的组织身份
        String importedToken = claimOrgAccount(fixture.orgCode(), "S2201", "13700001202");
        assertThat(getJson("/api/v1/org/current", importedToken)
                .path("data").path("realName").asText()).isEqualTo("张三");

        String failures = mockMvc.perform(get("/api/v1/org-admin/imports/" + batchId + "/failures")
                        .header("Authorization", "Bearer " + fixture.ownerToken()))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(failures).contains("行号").contains("4").contains("5");
    }

    @Test
    @DisplayName("批量导入：部门路径不存在时可自动逐级创建（需勾选开关）")
    void importAutoCreatesDepartmentPath() throws Exception {
        Fixture fixture = seedOrg("AUTO", "13700001211");

        String csv = "姓名,成员唯一识别 ID（学号/工号）,部门路径,角色\n"
                + "钱七,S2212,技术中心/后端组,MEMBER\n";

        long batchId = uploadMembers(fixture.ownerToken(), "auto.csv", csv, true)
                .path("data").path("batchId").asLong();
        JsonNode finished = awaitImport(fixture.ownerToken(), batchId);
        assertThat(finished.path("data").path("successCount").asInt())
                .as("批次返回: %s", finished.path("data").toString())
                .isEqualTo(1);

        JsonNode tree = getJson("/api/v1/org/departments/tree", fixture.ownerToken());
        // 部门路径是「从组织根开始」的绝对路径：首段不存在时会新建一个根级部门，
        // 与既有的「总部」平级，而不是挂在它下面。
        JsonNode tech = findByName(tree.path("data"), "技术中心");
        assertThat(tech).as("部门树: %s", tree.path("data").toString()).isNotNull();
        assertThat(tech.path("children")).hasSize(1);
        assertThat(tech.path("children").get(0).path("name").asText()).isEqualTo("后端组");
        assertThat(findByName(tree.path("data"), "总部")).isNotNull();

        // 未勾选开关时，路径不存在应逐行失败而不是静默建部门
        String csv2 = "姓名,成员唯一识别 ID（学号/工号）,部门路径,角色\n"
                + "孙八,S2213,不存在的部门/子部门,MEMBER\n";
        long batchId2 = uploadMembers(fixture.ownerToken(), "nofail.csv", csv2, false)
                .path("data").path("batchId").asLong();
        JsonNode finished2 = awaitImport(fixture.ownerToken(), batchId2);
        assertThat(finished2.path("data").path("failCount").asInt()).isEqualTo(1);
        assertThat(finished2.path("data").path("rows").get(0).path("errorMessage").asText())
                .contains("部门路径不存在");
    }

    @Test
    @DisplayName("可下载 xlsx 导入模板")
    void importTemplateIsDownloadable() throws Exception {
        Fixture fixture = seedOrg("TPL", "13700001221");

        byte[] template = mockMvc.perform(get("/api/v1/org-admin/members/import/template")
                        .header("Authorization", "Bearer " + fixture.ownerToken()))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsByteArray();

        assertThat(template).isNotEmpty();
        // xlsx 是 zip 容器，文件头魔数为 PK
        assertThat(template[0]).isEqualTo((byte) 'P');
        assertThat(template[1]).isEqualTo((byte) 'K');
    }

    @Test
    @DisplayName("组织日程可修改并同步到成员端，删除后成员端不再展示")
    void orgEventUpdateAndDelete() throws Exception {
        Fixture fixture = seedOrg("EDIT", "13700001231");
        long deptId = createDepartment(fixture, fixture.rootDepartmentId(), "编辑部");
        createMember(fixture, "13700001232", "编辑同学", deptId);
        String memberToken = claimOrgAccount(fixture.orgCode(), "13700001232");

        long eventId = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("初版标题", "DEPARTMENT", deptId, true, null))
                .path("data").path("eventId").asLong();

        JsonNode updated = patchJson("/api/v1/org-admin/events/" + eventId, fixture.ownerToken(),
                "{\"title\":\"改后标题\",\"location\":\"A 座 3F\"}");
        assertThat(updated.path("data").path("title").asText()).isEqualTo("改后标题");

        JsonNode memberView = rangeQuery("/api/v1/org/events", memberToken);
        assertThat(memberView.path("data").get(0).path("title").asText()).isEqualTo("改后标题");

        mockMvc.perform(delete("/api/v1/org-admin/events/" + eventId)
                        .header("Authorization", "Bearer " + fixture.ownerToken()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));

        assertThat(rangeQuery("/api/v1/org/events", memberToken).path("data")).isEmpty();
    }

    // ---------------------------------------------------------------- fixtures

    private record Fixture(long orgId, String orgCode, long rootDepartmentId, String ownerToken) {
    }

    /**
     * 造一个组织 + 根部门 + **未被认领的拥有者成员**，再用拥有者的凭据认领组织账号。
     *
     * <p>「手机号」在这个测试类里同时充当成员唯一识别 ID（学号/工号）——测试里没必要再造一批编号。
     */
    private Fixture seedOrg(String suffix, String ownerMemberKey) throws Exception {
        Long orgId = jdbcTemplate.queryForObject(
                "INSERT INTO organization (name, code) VALUES (?, ?) RETURNING id",
                Long.class, "测试组织" + suffix, "ORG" + suffix);
        Long rootId = jdbcTemplate.queryForObject(
                "INSERT INTO department (org_id, name, path, level) VALUES (?, '总部', '/0/', 1) RETURNING id",
                Long.class, orgId);
        jdbcTemplate.update("UPDATE department SET path = '/' || id || '/' WHERE id = ?", rootId);
        // 管理员导入成员：只写成员唯一识别 ID（spec §3.1），身份等认领时才产生
        jdbcTemplate.update(
                "INSERT INTO org_member (org_id, department_id, member_key, real_name, org_role, status) "
                        + "VALUES (?, ?, ?, '拥有者', 'OWNER', 'ACTIVE')",
                orgId, rootId, ownerMemberKey);

        String orgCode = "ORG" + suffix;
        return new Fixture(orgId, orgCode, rootId, claimOrgAccount(orgCode, ownerMemberKey));
    }

    /** 用手机号注册个人账号，返回个人身份的令牌。 */
    private String registerPersonalAccount(String phone) throws Exception {
        String code = postJson("/api/v1/auth/sms/code", null, "{\"phone\":\"" + phone + "\"}")
                .path("data").path("debugCode").asText();
        String registerToken = postJson("/api/v1/auth/login/sms", null,
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"dev\"}")
                .path("data").path("registerToken").asText();
        return postJson("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"用户" + phone.substring(phone.length() - 4) + "\",\"deviceId\":\"dev\"}")
                .path("data").path("accessToken").asText();
    }

    /**
     * 认领组织账号并拿该组织的令牌（spec §3.2）：登录动作本身就是绑定动作。
     *
     * @param phone 兼作成员唯一识别 ID（见 seedOrg 的说明）
     */
    private String claimOrgAccount(String orgCode, String memberKey) throws Exception {
        return claimOrgAccount(orgCode, memberKey, memberKey);
    }

    /**
     * @param memberKey 成员唯一识别 ID（学号/工号）——导入用例里它不再是手机号
     * @param phone     认领者自己的个人账号手机号
     */
    private String claimOrgAccount(String orgCode, String memberKey, String phone) throws Exception {
        String personalToken = registerPersonalAccount(phone);
        return postJson("/api/v1/org-accounts/login?deviceId=dev", personalToken,
                "{\"org\":\"" + orgCode + "\",\"memberKey\":\"" + memberKey + "\"}")
                .path("data").path("accessToken").asText();
    }

    private long createDepartment(Fixture fixture, long parentId, String name) throws Exception {
        return postJson("/api/v1/org-admin/departments", fixture.ownerToken(),
                "{\"parentId\":" + parentId + ",\"name\":\"" + name + "\"}")
                .path("data").path("id").asLong();
    }

    private long createMember(Fixture fixture, String memberKey, String realName, long departmentId) throws Exception {
        return postJson("/api/v1/org-admin/members", fixture.ownerToken(),
                "{\"memberKey\":\"" + memberKey + "\",\"realName\":\"" + realName + "\","
                        + "\"departmentId\":" + departmentId + "}")
                .path("data").path("id").asLong();
    }

    private void grantManager(Fixture fixture, long departmentId, long orgMemberId) throws Exception {
        postJson("/api/v1/org-admin/departments/" + departmentId + "/managers", fixture.ownerToken(),
                "{\"orgMemberId\":" + orgMemberId + "}");
    }

    private String dispatchBody(String title, String scopeType, Long departmentId,
                                boolean includeSub, String memberIds) {
        StringBuilder body = new StringBuilder()
                .append("{\"title\":\"").append(title).append("\",")
                .append("\"startAt\":\"2026-10-08T09:00:00+08:00\",")
                .append("\"endAt\":\"2026-10-08T11:00:00+08:00\",")
                .append("\"timezone\":\"Asia/Shanghai\",")
                .append("\"scopeType\":\"").append(scopeType).append("\",")
                .append("\"includeSubDepartments\":").append(includeSub).append(",")
                .append("\"requireReceipt\":true");
        if (departmentId != null) {
            body.append(",\"departmentId\":").append(departmentId);
        }
        if (memberIds != null) {
            body.append(",\"memberIds\":").append(memberIds);
        }
        return body.append("}").toString();
    }

    private int depth(JsonNode node) {
        JsonNode children = node.path("children");
        if (children.isEmpty()) {
            return 1;
        }
        return 1 + depth(children.get(0));
    }

    private JsonNode findByName(JsonNode array, String name) {
        for (JsonNode node : array) {
            if (name.equals(node.path("name").asText())) {
                return node;
            }
        }
        return null;
    }

    private java.util.List<String> names(JsonNode array) {
        java.util.List<String> result = new java.util.ArrayList<>();
        array.forEach(node -> result.add(node.path("realName").asText()));
        return result;
    }

    private JsonNode rangeQuery(String path, String token) throws Exception {
        return getJson(get(path)
                .param("start", RANGE_START)
                .param("end", RANGE_END)
                .header("Authorization", "Bearer " + token));
    }

    private JsonNode uploadMembers(String token, String fileName, String csv, boolean autoCreate)
            throws Exception {
        MockMultipartFile file = new MockMultipartFile(
                "file", fileName, "text/csv", csv.getBytes(StandardCharsets.UTF_8));
        MockHttpServletRequestBuilder builder = multipart("/api/v1/org-admin/members/import")
                .file(file)
                .param("autoCreateDepartment", String.valueOf(autoCreate))
                .header("Authorization", "Bearer " + token);
        String body = mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(body);
    }

    /**
     * 导入异步执行，测试轮询批次状态直到不再是 PROCESSING。
     */
    private JsonNode awaitImport(String token, long batchId) throws Exception {
        for (int attempt = 0; attempt < 200; attempt++) {
            JsonNode detail = getJson("/api/v1/org-admin/imports/" + batchId, token);
            if (!"PROCESSING".equals(detail.path("data").path("status").asText())) {
                return detail;
            }
            Thread.sleep(50L);
        }
        throw new AssertionError("导入未在预期时间内完成: batchId=" + batchId);
    }

    private JsonNode patchJson(String path, String token, String body) throws Exception {
        MockHttpServletRequestBuilder builder = patch(path)
                .contentType(MediaType.APPLICATION_JSON).content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        String response = mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
    }

    private JsonNode getJson(String path, String token) throws Exception {
        MockHttpServletRequestBuilder builder = get(path);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return getJson(builder);
    }

    private JsonNode getJson(MockHttpServletRequestBuilder builder) throws Exception {
        String body = mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(body);
    }

    private JsonNode postJson(String path, String token, String body) throws Exception {
        MockHttpServletRequestBuilder builder = post(path)
                .contentType(MediaType.APPLICATION_JSON).content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        String response = mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
    }
}
