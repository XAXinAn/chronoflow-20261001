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
    @DisplayName("检索覆盖所有已绑定组织的组织日程，撤回的下发不再出现")
    void searchCoversOrgEventsAcrossBoundOrganizations() throws Exception {
        Fixture first = seedOrg("SRCHA", "13700001401");
        // 第二个组织的成员用**同一个个人账号**认领：一个人可以绑多个组织
        UnclaimedOrg second = seedUnclaimedOrg("SRCHB", "SB002");
        String secondToken = claimWith(second.orgCode(), second.memberKey(), first.ownerPersonalToken());

        dispatchToAll(first.ownerToken(), "季度技术评审会");
        long eventInSecond = dispatchToAll(secondToken, "评审会材料准备");

        // 用**个人令牌**搜：个人身份要能搜到「我绑定的所有组织」的日程，不必先切组织
        JsonNode hits = searchByKeyword(first.ownerPersonalToken(), "评审会");
        assertThat(hits).hasSize(2);
        assertThat(orgNamesOf(hits)).containsExactlyInAnyOrder("测试组织SRCHA", "测试组织SRCHB");
        hits.forEach(item -> assertThat(item.path("type").asText()).isEqualTo("ORG_EVENT"));

        // 撤回第二条下发：它不该再出现在检索结果里（否则点开是空的）
        postJson("/api/v1/org-admin/events/" + eventInSecond + "/revoke", secondToken, "{}");
        JsonNode afterRevoke = searchByKeyword(first.ownerPersonalToken(), "评审会");
        assertThat(afterRevoke).hasSize(1);
        assertThat(afterRevoke.get(0).path("orgName").asText()).isEqualTo("测试组织SRCHA");
    }

    @Test
    @DisplayName("同一账号在同一组织只能绑一个成员账号：再认领别的成员会被明确拒绝")
    void onePersonalAccountBindsOneMemberPerOrg() throws Exception {
        Fixture fixture = seedOrg("SAME", "13700001301");
        long deptId = createDepartment(fixture, fixture.rootDepartmentId(), "研发部");
        createMember(fixture, "13700001302", "另一个成员", deptId);

        // 拥有者那个成员账号已被这个个人账号绑定，现在再认领同组织的另一个成员
        JsonNode denied = postRaw("/api/v1/org-accounts/login?deviceId=dev",
                fixture.ownerPersonalToken(),
                "{\"org\":\"" + fixture.orgCode() + "\",\"memberKey\":\"13700001302\"}");

        assertThat(denied.path("code").asInt()).isEqualTo(20003);
        assertThat(denied.path("message").asText()).contains("已绑定成员");
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
    @DisplayName("下发到部门：被下发到的成员看得到，没被下发到的看不到（首版不收集回执）")
    void dispatchToDepartmentReachesItsMembers() throws Exception {
        Fixture fixture = seedOrg("DISP", "13700001109");
        long deptId = createDepartment(fixture, fixture.rootDepartmentId(), "产品部");
        createMember(fixture, "13700001110", "产品同学A", deptId);
        createMember(fixture, "13700001111", "产品同学B", deptId);

        JsonNode dispatched = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("产品评审", "DEPARTMENT", deptId, true, null));
        assertThat(dispatched.path("data").path("eventId").asLong()).isPositive();

        String memberToken = claimOrgAccount(fixture.orgCode(), "13700001110");
        JsonNode events = rangeQuery("/api/v1/org/events", memberToken);
        assertThat(events.path("data")).hasSize(1);
        assertThat(events.path("data").get(0).path("title").asText()).isEqualTo("产品评审");
        // 响应体里没有回执状态这种东西了（首版不收集回执，spec §4.2.2）
        assertThat(events.path("data").get(0).path("receiptStatus").isMissingNode()).isTrue();
        assertThat(events.path("data").get(0).path("canEdit").asBoolean()).isFalse();

        // 发起人自己也看得到，并且只有他能编辑
        JsonNode ownerSees = rangeQuery("/api/v1/org/events", fixture.ownerToken());
        assertThat(ownerSees.path("data")).hasSize(1);
        assertThat(ownerSees.path("data").get(0).path("canEdit").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("成员无法创建组织日程，也看不到下发给别人的日程")
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

        // A 部成员看不到下发给 B 部的日程
        JsonNode aEvents = rangeQuery("/api/v1/org/events", memberToken);
        assertThat(aEvents.path("data")).isEmpty();

        // 也不能改别人的下发（只有发起人能改，spec §4.2.2）
        mockMvc.perform(patch("/api/v1/org-admin/events/" + eventId)
                        .header("Authorization", "Bearer " + memberToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"我要改别人的\"}"))
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
    @DisplayName("撤回下发后成员端不再展示（首版不收集回执，所以没有「已回执不可撤回」）")
    void revokeHidesEventFromMembers() throws Exception {
        Fixture fixture = seedOrg("REV", "13700001118");
        long deptId = createDepartment(fixture, fixture.rootDepartmentId(), "运营部");
        createMember(fixture, "13700001119", "运营同学", deptId);

        JsonNode dispatched = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("运营例会", "DEPARTMENT", deptId, true, null));
        long eventId = dispatched.path("data").path("eventId").asLong();

        String memberToken = claimOrgAccount(fixture.orgCode(), "13700001119");
        assertThat(rangeQuery("/api/v1/org/events", memberToken).path("data")).hasSize(1);

        postJson("/api/v1/org-admin/events/" + eventId + "/revoke", fixture.ownerToken(), "{}");

        // 撤回后成员端（含发起人自己）都不再展示
        assertThat(rangeQuery("/api/v1/org/events", memberToken).path("data")).isEmpty();
        assertThat(rangeQuery("/api/v1/org/events", fixture.ownerToken()).path("data")).isEmpty();
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

    @Test
    @DisplayName("组织管理端：后台 ORG_ADMIN 令牌就能给全新组织建部门、导成员、下发日程")
    void orgAdminConsoleCanOpenUpANewOrganization() throws Exception {
        String superToken = adminLogin("admin", "admin123456");
        JsonNode created = postJson("/api/v1/admin/organizations", superToken,
                "{\"name\":\"控制台组织\",\"code\":\"WEBORG1\",\"adminUsername\":\"weborg1_admin\","
                        + "\"adminPassword\":\"weborg1pass\",\"adminRealName\":\"控制台管理员\"}");
        assertThat(created.path("code").asInt()).isZero();
        String consoleToken = adminLogin("weborg1_admin", "weborg1pass");

        // 全新组织：一个成员都没有。这正是原来「没有入口导入首位成员」的场景
        JsonNode beforeSettings = getJson("/api/v1/org-admin/settings", consoleToken);
        assertThat(beforeSettings.path("data").path("code").asText()).isEqualTo("WEBORG1");
        assertThat(beforeSettings.path("data").path("memberCount").asInt()).isZero();

        long rootId = postJson("/api/v1/org-admin/departments", consoleToken,
                "{\"name\":\"总部\"}").path("data").path("id").asLong();
        assertThat(rootId).isPositive();

        long memberId = postJson("/api/v1/org-admin/members", consoleToken,
                "{\"memberKey\":\"W1001\",\"realName\":\"王小明\",\"departmentId\":" + rootId + "}")
                .path("data").path("id").asLong();
        assertThat(memberId).isPositive();

        String csv = "姓名,成员唯一识别 ID（学号/工号）,部门路径,角色\n"
                + "李四,W1002,总部,MEMBER\n";
        long batchId = uploadMembers(consoleToken, "console.csv", csv, false)
                .path("data").path("batchId").asLong();
        JsonNode finished = awaitImport(consoleToken, batchId);
        assertThat(finished.path("data").path("successCount").asInt())
                .as("批次返回: %s", finished.path("data").toString())
                .isEqualTo(1);

        JsonNode members = getJson("/api/v1/org-admin/members", consoleToken);
        assertThat(names(members.path("data"))).containsExactlyInAnyOrder("王小明", "李四");
        assertThat(getJson("/api/v1/org-admin/settings", consoleToken)
                .path("data").path("memberCount").asInt()).isEqualTo(2);

        // 组织设置可改；成员上限只读，请求里带了也不生效
        JsonNode updatedSettings = patchJson("/api/v1/org-admin/settings", consoleToken,
                "{\"name\":\"控制台组织（改）\",\"contactName\":\"前台\",\"timezone\":\"Asia/Shanghai\","
                        + "\"maxMembers\":999999}");
        assertThat(updatedSettings.path("data").path("name").asText()).isEqualTo("控制台组织（改）");
        assertThat(updatedSettings.path("data").path("contactName").asText()).isEqualTo("前台");

        // 导进来的成员能认领组织账号 —— 这就是「首位成员」闭环的另一半
        // 手机号必须全类唯一：重号会撞 60 秒发送频控（AGENTS.md §5 已记过的坑）
        String memberToken = claimOrgAccount("WEBORG1", "W1002", "13700001501");
        assertThat(getJson("/api/v1/org/current", memberToken).path("data").path("realName").asText())
                .isEqualTo("李四");

        // 后台下发组织日程：没有 C 端身份，发起方落在 created_by_admin_id 上（spec §5.6）
        long eventId = postJson("/api/v1/org-admin/events", consoleToken,
                dispatchBody("新组织第一场会", "ALL", null, true, null))
                .path("data").path("eventId").asLong();
        JsonNode events = rangeQuery("/api/v1/org-admin/events", consoleToken);
        assertThat(events.path("data")).hasSize(1);
        assertThat(events.path("data").get(0).path("title").asText()).isEqualTo("新组织第一场会");
        assertThat(events.path("data").get(0).path("recipientCount").asInt()).isEqualTo(2);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT creator_identity_id FROM event WHERE id = ?", Long.class, eventId)).isNull();
        assertThat(jdbcTemplate.queryForObject(
                "SELECT created_by_admin_id FROM event_dispatch WHERE event_id = ?", Long.class, eventId))
                .isNotNull();
        // 成员自己能读到这条下发
        assertThat(rangeQuery("/api/v1/org/events", memberToken).path("data")).hasSize(1);

        // 部门树（管理端）与操作日志都是真实数据（spec §4.3）
        JsonNode tree = getJson("/api/v1/org-admin/departments", consoleToken);
        assertThat(findByName(tree.path("data"), "总部")).isNotNull();
        JsonNode logs = getJson("/api/v1/org-admin/logs", consoleToken);
        java.util.List<String> actions = new java.util.ArrayList<>();
        logs.path("data").forEach(node -> actions.add(node.path("action").asText()));
        assertThat(actions).contains("ORG_DEPARTMENT_CREATE", "ORG_MEMBER_CREATE",
                "ORG_MEMBER_IMPORT", "ORG_EVENT_DISPATCH", "ORG_SETTINGS_UPDATE");
    }

    @Test
    @DisplayName("发起人自己也收得到、也管得了自己下发的组织日程")
    void initiatorSeesAndManagesOwnDispatch() throws Exception {
        Fixture fixture = seedOrg("SELF", "13700001601");
        long deptId = createDepartment(fixture, fixture.rootDepartmentId(), "研发部");
        long targetId = createMember(fixture, "13700001602", "研发同学", deptId);
        String managerKey = "13700001603";
        long managerId = createMember(fixture, managerKey, "部门负责人", deptId);
        grantManager(fixture, deptId, managerId);
        String managerToken = claimOrgAccount(fixture.orgCode(), managerKey);
        String bystanderToken = claimOrgAccount(fixture.orgCode(), "13700001602");

        // 部门管理员用「指定成员」下发给同事：目标里没有他自己
        long eventId = postJson("/api/v1/org-admin/events", managerToken,
                "{\"title\":\"组内同步\",\"at\":\"" + RANGE_START + "\","
                        + "\"scopeType\":\"MEMBER\","
                        + "\"memberIds\":[" + targetId + "]}")
                .path("data").path("eventId").asLong();

        // ① 发起人自己也要看得到：组织 tab 的口径是「发给我 / 我参与的」
        JsonNode mine = rangeQuery("/api/v1/org/events", managerToken);
        assertThat(mine.path("data")).as("发起人应该能看到自己下发的日程").hasSize(1);
        assertThat(mine.path("data").get(0).path("canEdit").asBoolean()).isTrue();
        // 收件人里包含发起人自己（同事 + 自己 = 2）
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM event_recipient WHERE event_id = ?", Integer.class, eventId))
                .isEqualTo(2);

        // ② 发起人能改、能撤自己下发的（原来「指定成员」范围会让他被判无权限）
        JsonNode updated = patchJson("/api/v1/org-admin/events/" + eventId, managerToken,
                "{\"title\":\"组内同步（改）\"}");
        assertThat(updated.path("code").asInt()).as("发起人应能编辑: %s", updated).isZero();

        // 同事只是收件人，不是发起人也不是管理员 → 不能改
        JsonNode denied = patchJson("/api/v1/org-admin/events/" + eventId, bystanderToken,
                "{\"title\":\"我要改别人的\"}");
        assertThat(denied.path("code").asInt()).isEqualTo(20003);
        assertThat(rangeQuery("/api/v1/org/events", bystanderToken)
                .path("data").get(0).path("canEdit").asBoolean()).isFalse();

        // 组织管理员也不行：只有发起人能改自己那条（spec §4.2.2）
        JsonNode adminDenied = patchJson("/api/v1/org-admin/events/" + eventId, fixture.ownerToken(),
                "{\"title\":\"管理员替人改\"}");
        assertThat(adminDenied.path("code").asInt()).isEqualTo(20003);

        // 撤回同样按发起人放行
        JsonNode revoked = postJson("/api/v1/org-admin/events/" + eventId + "/revoke", managerToken, "{}");
        assertThat(revoked.path("code").asInt()).as("发起人应能撤回: %s", revoked).isZero();
    }

    @Test
    @DisplayName("组织管理端日程列表：canEdit 只认发起人；includeRevoked 能翻到已撤回的下发")
    void adminEventListReportsCanEditAndRevokedHistory() throws Exception {
        Fixture fixture = seedOrg("HIST", "13700001701");
        // 另一位**组织管理员**（不是发起人）：管理端能看列表，但按钮不该给他
        long otherAdminId = createMember(fixture, "13700001702", "另一位管理员",
                fixture.rootDepartmentId());
        patchJson("/api/v1/org-admin/members/" + otherAdminId, fixture.ownerToken(),
                "{\"orgRole\":\"ADMIN\"}");
        String otherAdminToken = claimOrgAccount(fixture.orgCode(), "13700001702");

        // 拥有者从 App 下发一条（管理端列表里的条目就是这条）
        long eventId = postJson("/api/v1/org-admin/events", fixture.ownerToken(),
                dispatchBody("组内同步", "ALL", null, true, null))
                .path("data").path("eventId").asLong();

        JsonNode mine = rangeQuery("/api/v1/org-admin/events", fixture.ownerToken());
        assertThat(mine.path("data")).hasSize(1);
        assertThat(mine.path("data").get(0).path("canEdit").asBoolean())
                .as("发起人在管理端应可操作: %s", mine).isTrue();
        assertThat(mine.path("data").get(0).path("status").asText()).isEqualTo("ACTIVE");

        JsonNode other = rangeQuery("/api/v1/org-admin/events", otherAdminToken);
        assertThat(other.path("data")).hasSize(1);
        assertThat(other.path("data").get(0).path("canEdit").asBoolean())
                .as("组织管理员不是发起人，页面不该给他按钮: %s", other).isFalse();

        // 撤回后默认列表里消失；includeRevoked=true 能翻到这条历史，状态是 REVOKED
        postJson("/api/v1/org-admin/events/" + eventId + "/revoke", fixture.ownerToken(), "{}");
        assertThat(rangeQuery("/api/v1/org-admin/events", fixture.ownerToken()).path("data"))
                .as("撤回后默认列表不该再出现").isEmpty();

        JsonNode history = getJson(get("/api/v1/org-admin/events")
                .param("start", RANGE_START)
                .param("end", RANGE_END)
                .param("includeRevoked", "true")
                .header("Authorization", "Bearer " + fixture.ownerToken()));
        assertThat(history.path("data")).hasSize(1);
        assertThat(history.path("data").get(0).path("status").asText()).isEqualTo("REVOKED");
        assertThat(history.path("data").get(0).path("canEdit").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("组织管理端：后台令牌只作用于自己那个组织（跨组织与成员令牌都挡住）")
    void orgConsoleTokenIsScopedAcrossOrganizations() throws Exception {
        String superToken = adminLogin("admin", "admin123456");
        long orgA = postJson("/api/v1/admin/organizations", superToken,
                "{\"name\":\"组织A\",\"code\":\"SCOPEA\",\"adminUsername\":\"scopea_admin\","
                        + "\"adminPassword\":\"scopeapass\"}").path("data").path("id").asLong();
        long orgB = postJson("/api/v1/admin/organizations", superToken,
                "{\"name\":\"组织B\",\"code\":\"SCOPEB\",\"adminUsername\":\"scopeb_admin\","
                        + "\"adminPassword\":\"scopebpass\"}").path("data").path("id").asLong();
        assertThat(orgA).isNotEqualTo(orgB);

        // 组织 B 里塞一个成员，供越权尝试
        Long deptB = jdbcTemplate.queryForObject(
                "INSERT INTO department (org_id, name, path, level) VALUES (?, '总部', '/0/', 1) RETURNING id",
                Long.class, orgB);
        jdbcTemplate.update("UPDATE department SET path = '/' || id || '/' WHERE id = ?", deptB);
        Long memberB = jdbcTemplate.queryForObject(
                "INSERT INTO org_member (org_id, department_id, member_key, real_name, org_role, status) "
                        + "VALUES (?, ?, 'B1001', 'B组织成员', 'MEMBER', 'ACTIVE') RETURNING id",
                Long.class, orgB, deptB);

        String consoleA = adminLogin("scopea_admin", "scopeapass");
        // A 的管理员看不到 B 的成员，也改不动 B 的成员
        assertThat(getJson("/api/v1/org-admin/members", consoleA).path("data")).isEmpty();
        JsonNode denied = patchJson("/api/v1/org-admin/members/" + memberB, consoleA,
                "{\"realName\":\"越权改名\"}");
        assertThat(denied.path("code").asInt()).isEqualTo(20003);

        // 组织身份里的普通成员不能调管理端接口（spec §2.2）
        // 先在 A 里建一个普通成员，让他认领
        String consoleAToken = consoleA;
        long rootA = postJson("/api/v1/org-admin/departments", consoleAToken, "{\"name\":\"总部\"}")
                .path("data").path("id").asLong();
        postJson("/api/v1/org-admin/members", consoleAToken,
                "{\"memberKey\":\"A2001\",\"realName\":\"甲成员\",\"departmentId\":" + rootA + "}");
        String memberToken = claimOrgAccount("SCOPEA", "A2001", "13700001502");

        JsonNode forbidden = uploadMembersExpectingFailure(memberToken, "x.csv",
                "姓名,成员唯一识别 ID（学号/工号）,部门路径,角色\n小兵,A2002,总部,MEMBER\n", false);
        assertThat(forbidden.path("code").asInt()).isEqualTo(20003);
    }

    // ---------------------------------------------------------------- fixtures

    private record Fixture(long orgId, String orgCode, long rootDepartmentId, String ownerToken,
                           String ownerPersonalToken) {
    }

    private record Claim(String personalToken, String orgToken) {
    }

    /** 只播种一个组织 + 根部门 + 未认领的成员，不做认领（认领要用指定的个人令牌）。 */
    private record UnclaimedOrg(long orgId, String orgCode, long rootDepartmentId, String memberKey) {
    }

    /**
     * 造一个组织 + 根部门 + **未被认领的拥有者成员**，再用拥有者的凭据认领组织账号。
     *
     * <p>「手机号」在这个测试类里同时充当成员唯一识别 ID（学号/工号）——测试里没必要再造一批编号。
     */
    private Fixture seedOrg(String suffix, String ownerMemberKey) throws Exception {
        UnclaimedOrg org = seedUnclaimedOrg(suffix, ownerMemberKey);
        Claim claim = claimOrgAccountWithTokens(org.orgCode(), ownerMemberKey, ownerMemberKey);
        return new Fixture(org.orgId(), org.orgCode(), org.rootDepartmentId(), claim.orgToken(),
                claim.personalToken());
    }

    private UnclaimedOrg seedUnclaimedOrg(String suffix, String memberKey) {
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
                orgId, rootId, memberKey);

        return new UnclaimedOrg(orgId, "ORG" + suffix, rootId, memberKey);
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
        return claimOrgAccountWithTokens(orgCode, memberKey, phone).orgToken();
    }

    /** 用**已有的个人令牌**认领（一个人绑多个组织时用得到）。 */
    private String claimWith(String orgCode, String memberKey, String personalToken) throws Exception {
        return postJson("/api/v1/org-accounts/login?deviceId=dev", personalToken,
                "{\"org\":\"" + orgCode + "\",\"memberKey\":\"" + memberKey + "\"}")
                .path("data").path("accessToken").asText();
    }

    /** 组织管理员把一条日程下发给全组织，返回 eventId。 */
    private long dispatchToAll(String orgToken, String title) throws Exception {
        return postJson("/api/v1/org-admin/events", orgToken,
                "{\"title\":\"" + title + "\",\"at\":\"2026-10-08T09:00:00+08:00\","
                        + "\"scopeType\":\"ALL\"}")
                .path("data").path("eventId").asLong();
    }

    /** 认领并同时拿到个人令牌（用于验证「同一账号在同一组织只能绑一个成员」这类规则）。 */
    private Claim claimOrgAccountWithTokens(String orgCode, String memberKey, String phone) throws Exception {
        String personalToken = registerPersonalAccount(phone);
        JsonNode claimed = postJson("/api/v1/org-accounts/login?deviceId=dev", personalToken,
                "{\"org\":\"" + orgCode + "\",\"memberKey\":\"" + memberKey + "\"}")
                ;
        return new Claim(personalToken, claimed.path("data").path("accessToken").asText());
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
                .append("\"at\":\"2026-10-08T09:00:00+08:00\",")
                .append("")
                .append("\"timezone\":\"Asia/Shanghai\",")
                .append("\"scopeType\":\"").append(scopeType).append("\",")
                .append("\"includeSubDepartments\":").append(includeSub);
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

    /** 批量导入被拒时的响应体：权限不足走 HTTP 200 + 业务错误码（spec §6.1）。 */
    private JsonNode uploadMembersExpectingFailure(String token, String fileName, String csv,
                                                   boolean autoCreate) throws Exception {
        MockMultipartFile file = new MockMultipartFile(
                "file", fileName, "text/csv", csv.getBytes(StandardCharsets.UTF_8));
        String body = mockMvc.perform(multipart("/api/v1/org-admin/members/import")
                        .file(file)
                        .param("autoCreateDepartment", String.valueOf(autoCreate))
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(body);
    }

    /** 平台超管登录（首次启动自动创建，spec §4.4）。 */
    private String adminLogin(String username, String password) throws Exception {
        return postJson("/api/v1/admin/auth/login", null,
                "{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}")
                .path("data").path("accessToken").asText();
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

    /** 不校验业务成功码：专门用于「应该被挡住」的用例，需要读错误码与文案。 */
    private JsonNode postRaw(String path, String token, String body) throws Exception {
        MockHttpServletRequestBuilder builder = post(path)
                .contentType(MediaType.APPLICATION_JSON).content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        String response = mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(response);
    }

    /**
     * 关键字检索。关键字用 {@code .param()} 传，不走 URL 模板——
     * 中文塞进 URL 会被编码成不可预期的形式，那测的就不是服务端行为。
     */
    private JsonNode searchByKeyword(String token, String keyword) throws Exception {
        MockHttpServletRequestBuilder builder = get("/api/v1/search")
                .param("keyword", keyword)
                .header("Authorization", "Bearer " + token);
        JsonNode json = getJson(builder);
        assertThat(json.path("code").asInt()).isZero();
        return json.path("data");
    }

    private java.util.List<String> orgNamesOf(JsonNode items) {
        java.util.List<String> names = new java.util.ArrayList<>();
        items.forEach(item -> names.add(item.path("orgName").asText()));
        return names;
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
