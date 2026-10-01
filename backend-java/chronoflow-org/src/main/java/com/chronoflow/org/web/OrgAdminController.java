package com.chronoflow.org.web;

import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.org.dto.OrgDtos.DepartmentCreateRequest;
import com.chronoflow.org.dto.OrgDtos.DepartmentNode;
import com.chronoflow.org.dto.OrgDtos.DepartmentUpdateRequest;
import com.chronoflow.org.dto.OrgDtos.DeptManagerGrantRequest;
import com.chronoflow.org.dto.OrgDtos.OrgEventDispatchRequest;
import com.chronoflow.org.dto.OrgDtos.OrgEventManageItem;
import com.chronoflow.org.dto.OrgDtos.OrgEventResponse;
import com.chronoflow.org.dto.OrgDtos.OrgEventUpdateRequest;
import com.chronoflow.org.dto.OrgDtos.OrgMemberCreateRequest;
import com.chronoflow.org.dto.OrgDtos.OrgMemberResponse;
import com.chronoflow.org.dto.OrgDtos.OrgMemberUpdateRequest;
import com.chronoflow.org.dto.OrgDtos.OrgSettingsResponse;
import com.chronoflow.org.dto.OrgDtos.OrgSettingsUpdateRequest;
import com.chronoflow.org.dto.OrgDtos.ImportBatchResponse;
import com.chronoflow.org.entity.Department;
import com.chronoflow.org.entity.ImportBatch;
import com.chronoflow.org.service.DepartmentService;
import com.chronoflow.org.service.MemberImportService;
import com.chronoflow.org.service.OrgActor;
import com.chronoflow.org.service.OrgAuditRecorder;
import com.chronoflow.org.service.OrgEventService;
import com.chronoflow.org.service.OrgMemberService;
import com.chronoflow.org.service.OrgPermissionService;
import com.chronoflow.org.service.OrgSettingsService;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * 组织管理端接口，对应 spec §6.3「组织管理员」分组。
 *
 * <p>两个入口通向同一个角色（spec §3.2 / §4.3）：App 里的组织身份令牌，
 * 或 Web 组织管理端的后台 `ORG_ADMIN` 令牌。前者由 {@code /org-admin/**} 的旧契约保证，
 * 后者解决「新组织一个成员都没有、于是谁也进不来」的死循环。
 *
 * <p>权限在 Service 层强制校验：组织管理员可管全组织，部门管理员仅限被授权部门及其所有下级。
 */
@RestController
@RequestMapping("/api/v1/org-admin")
@SecurityRequirement(name = "bearerAuth")
public class OrgAdminController {

    private final OrgPermissionService permission;
    private final DepartmentService departmentService;
    private final OrgMemberService orgMemberService;
    private final OrgEventService orgEventService;
    private final MemberImportService memberImportService;
    private final OrgSettingsService orgSettingsService;
    private final OrgAuditRecorder audit;

    public OrgAdminController(OrgPermissionService permission,
                              DepartmentService departmentService,
                              OrgMemberService orgMemberService,
                              OrgEventService orgEventService,
                              MemberImportService memberImportService,
                              OrgSettingsService orgSettingsService,
                              OrgAuditRecorder audit) {
        this.permission = permission;
        this.departmentService = departmentService;
        this.orgMemberService = orgMemberService;
        this.orgEventService = orgEventService;
        this.memberImportService = memberImportService;
        this.orgSettingsService = orgSettingsService;
        this.audit = audit;
    }

    // ------------------------------------------------------------------ 部门

    @GetMapping("/departments")
    public ApiResponse<List<DepartmentNode>> departmentTree() {
        OrgActor actor = actor();
        return ApiResponse.ok(departmentService.tree(actor.getOrgId()));
    }

    @PostMapping("/departments")
    public ApiResponse<Department> createDepartment(@Valid @RequestBody DepartmentCreateRequest request) {
        OrgActor actor = actor();
        Department created = departmentService.create(actor, request);
        audit.record(actor, "ORG_DEPARTMENT_CREATE", "DEPARTMENT", created.getId(),
                Map.of("name", created.getName()));
        return ApiResponse.ok(created);
    }

    @PatchMapping("/departments/{id}")
    public ApiResponse<Department> updateDepartment(@PathVariable Long id,
                                                    @Valid @RequestBody DepartmentUpdateRequest request) {
        OrgActor actor = actor();
        Department updated = departmentService.update(actor, id, request);
        audit.record(actor, "ORG_DEPARTMENT_UPDATE", "DEPARTMENT", id, null);
        return ApiResponse.ok(updated);
    }

    @DeleteMapping("/departments/{id}")
    public ApiResponse<Void> deleteDepartment(@PathVariable Long id) {
        OrgActor actor = actor();
        departmentService.delete(actor, id);
        audit.record(actor, "ORG_DEPARTMENT_DELETE", "DEPARTMENT", id, null);
        return ApiResponse.ok();
    }

    @PostMapping("/departments/{id}/managers")
    public ApiResponse<Void> grantManager(@PathVariable Long id,
                                          @Valid @RequestBody DeptManagerGrantRequest request) {
        OrgActor actor = actor();
        departmentService.grantManager(actor, id, request.orgMemberId());
        audit.record(actor, "ORG_DEPARTMENT_MANAGER_GRANT", "DEPARTMENT", id,
                Map.of("orgMemberId", request.orgMemberId()));
        return ApiResponse.ok();
    }

    @DeleteMapping("/departments/{id}/managers/{orgMemberId}")
    public ApiResponse<Void> revokeManager(@PathVariable Long id, @PathVariable Long orgMemberId) {
        OrgActor actor = actor();
        departmentService.revokeManager(actor, id, orgMemberId);
        audit.record(actor, "ORG_DEPARTMENT_MANAGER_REVOKE", "DEPARTMENT", id,
                Map.of("orgMemberId", orgMemberId));
        return ApiResponse.ok();
    }

    // ------------------------------------------------------------------ 成员

    @GetMapping("/members")
    public ApiResponse<List<OrgMemberResponse>> members() {
        OrgActor actor = actor();
        return ApiResponse.ok(orgMemberService.list(actor, null));
    }

    @PostMapping("/members")
    public ApiResponse<OrgMemberResponse> createMember(@Valid @RequestBody OrgMemberCreateRequest request) {
        OrgActor actor = actor();
        OrgMemberResponse created = orgMemberService.create(actor, request);
        audit.record(actor, "ORG_MEMBER_CREATE", "ORG_MEMBER", created.id(),
                Map.of("memberKey", created.memberKey(), "departmentId", created.departmentId()));
        return ApiResponse.ok(created);
    }

    @PatchMapping("/members/{id}")
    public ApiResponse<OrgMemberResponse> updateMember(@PathVariable Long id,
                                                       @Valid @RequestBody OrgMemberUpdateRequest request) {
        OrgActor actor = actor();
        OrgMemberResponse updated = orgMemberService.update(actor, id, request);
        audit.record(actor, "ORG_MEMBER_UPDATE", "ORG_MEMBER", id, null);
        return ApiResponse.ok(updated);
    }

    /**
     * 解绑成员的组织账号（spec §3.2 / §6.3）。
     *
     * <p>成员换个人账号、或账号被他人冒领时，靠它把认领关系清掉；成员记录本身保留。
     */
    @PostMapping("/members/{id}/unbind")
    public ApiResponse<OrgMemberResponse> unbindMember(@PathVariable Long id) {
        OrgActor actor = actor();
        OrgMemberResponse unbound = orgMemberService.unbind(actor, id);
        audit.record(actor, "ORG_MEMBER_UNBIND", "ORG_MEMBER", id, null);
        return ApiResponse.ok(unbound);
    }

    // -------------------------------------------------------------- 组织日程

    /**
     * 组织管理端的组织日程列表：本组织在时间范围内的下发（spec §6.3）。
     *
     * <p>默认只列活跃下发；{@code includeRevoked=true} 时带上已撤回的，用于历史回溯。
     * 每条带 {@code canEdit}（只有发起人为 true）和 {@code status}（ACTIVE / REVOKED）。
     */
    @GetMapping("/events")
    public ApiResponse<List<OrgEventManageItem>> events(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime start,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime end,
            @RequestParam(required = false, defaultValue = "false") boolean includeRevoked) {
        OrgActor actor = actor();
        return ApiResponse.ok(orgEventService.listForAdmin(
                actor, start.toInstant(), end.toInstant(), includeRevoked));
    }

    @PostMapping("/events")
    public ApiResponse<OrgEventResponse> dispatch(@Valid @RequestBody OrgEventDispatchRequest request) {
        OrgActor actor = actor();
        OrgEventResponse response = orgEventService.dispatch(actor, request);
        audit.record(actor, "ORG_EVENT_DISPATCH", "EVENT", response.eventId(),
                Map.of("scopeType", request.scopeType(), "dispatchId", response.dispatchId()));
        return ApiResponse.ok(response);
    }

    @PostMapping("/events/{id}/revoke")
    public ApiResponse<Void> revoke(@PathVariable Long id) {
        OrgActor actor = actor();
        orgEventService.revoke(actor, id);
        audit.record(actor, "ORG_EVENT_REVOKE", "EVENT", id, null);
        return ApiResponse.ok();
    }

    @PatchMapping("/events/{id}")
    public ApiResponse<OrgEventResponse> updateEvent(@PathVariable Long id,
                                                     @Valid @RequestBody OrgEventUpdateRequest request) {
        OrgActor actor = actor();
        OrgEventResponse response = orgEventService.update(actor, id, request);
        audit.record(actor, "ORG_EVENT_UPDATE", "EVENT", id, null);
        return ApiResponse.ok(response);
    }

    @DeleteMapping("/events/{id}")
    public ApiResponse<Void> deleteEvent(@PathVariable Long id) {
        OrgActor actor = actor();
        orgEventService.delete(actor, id);
        audit.record(actor, "ORG_EVENT_DELETE", "EVENT", id, null);
        return ApiResponse.ok();
    }

    // -------------------------------------------------------------- 组织设置

    @GetMapping("/settings")
    public ApiResponse<OrgSettingsResponse> settings() {
        return ApiResponse.ok(orgSettingsService.get(actor()));
    }

    @PatchMapping("/settings")
    public ApiResponse<OrgSettingsResponse> updateSettings(
            @Valid @RequestBody OrgSettingsUpdateRequest request) {
        OrgActor actor = actor();
        OrgSettingsResponse updated = orgSettingsService.update(actor, request);
        audit.record(actor, "ORG_SETTINGS_UPDATE", "ORGANIZATION", actor.getOrgId(), null);
        return ApiResponse.ok(updated);
    }

    // -------------------------------------------------------------- 成员导入

    /**
     * 上传模板文件批量导入成员，立即返回 batchId，逐行结果异步产出。
     */
    @PostMapping(value = "/members/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<ImportBatchResponse> importMembers(
            @RequestPart("file") MultipartFile file,
            @RequestParam(defaultValue = "false") boolean autoCreateDepartment) throws IOException {
        OrgActor actor = actor();
        if (file.isEmpty()) {
            throw com.chronoflow.common.exception.BizException.of(
                    com.chronoflow.common.api.ErrorCode.PARAM_INVALID, "上传文件为空");
        }
        ImportBatch batch = memberImportService.startImport(
                actor, file.getOriginalFilename(), file.getBytes(), autoCreateDepartment);
        audit.record(actor, "ORG_MEMBER_IMPORT", "IMPORT_BATCH", batch.getId(),
                Map.of("fileName", String.valueOf(batch.getFileName()), "totalCount", batch.getTotalCount()));
        return ApiResponse.ok(memberImportService.detail(actor, batch.getId()));
    }

    @GetMapping("/members/import/template")
    public ResponseEntity<Resource> importTemplate() {
        actor();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"member-import-template.xlsx\"")
                .contentType(MediaType.parseMediaType(
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(new ByteArrayResource(memberImportService.template()));
    }

    @GetMapping("/imports")
    public ApiResponse<List<ImportBatch>> imports() {
        OrgActor actor = actor();
        return ApiResponse.ok(memberImportService.listBatches(actor));
    }

    @GetMapping("/imports/{id}")
    public ApiResponse<ImportBatchResponse> importDetail(@PathVariable Long id) {
        OrgActor actor = actor();
        return ApiResponse.ok(memberImportService.detail(actor, id));
    }

    @GetMapping(value = "/imports/{id}/failures", produces = "text/csv;charset=UTF-8")
    public ResponseEntity<String> importFailures(@PathVariable Long id) {
        OrgActor actor = actor();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"import-failures-" + id + ".csv\"")
                .contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
                .body(memberImportService.failureCsv(actor, id));
    }

    /**
     * 当前执行者：App 的组织身份（§4.2），或 Web 组织管理端的后台管理员（§4.3）。
     */
    private OrgActor actor() {
        return permission.resolveActor();
    }
}
