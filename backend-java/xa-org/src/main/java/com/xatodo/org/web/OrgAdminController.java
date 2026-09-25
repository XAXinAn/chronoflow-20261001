package com.xatodo.org.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.org.dto.OrgDtos.DepartmentCreateRequest;
import com.xatodo.org.dto.OrgDtos.DepartmentUpdateRequest;
import com.xatodo.org.dto.OrgDtos.DeptManagerGrantRequest;
import com.xatodo.org.dto.OrgDtos.OrgEventDispatchRequest;
import com.xatodo.org.dto.OrgDtos.OrgEventResponse;
import com.xatodo.org.dto.OrgDtos.OrgEventUpdateRequest;
import com.xatodo.org.dto.OrgDtos.OrgMemberCreateRequest;
import com.xatodo.org.dto.OrgDtos.OrgMemberResponse;
import com.xatodo.org.dto.OrgDtos.OrgMemberUpdateRequest;
import com.xatodo.org.dto.OrgDtos.ReceiptSummaryResponse;
import com.xatodo.org.dto.OrgDtos.ImportBatchResponse;
import com.xatodo.org.entity.Department;
import com.xatodo.org.entity.ImportBatch;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.service.DepartmentService;
import com.xatodo.org.service.MemberImportService;
import com.xatodo.org.service.OrgEventService;
import com.xatodo.org.service.OrgMemberService;
import com.xatodo.org.service.OrgPermissionService;
import jakarta.validation.Valid;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
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
import java.util.List;

/**
 * 组织管理端接口，对应 spec §6.3「组织管理员」分组。
 *
 * <p>权限在 Service 层强制校验：组织管理员可管全组织，部门管理员仅限被授权部门及其所有下级。
 */
@RestController
@RequestMapping("/api/v1/org-admin")
public class OrgAdminController {

    private final OrgPermissionService permission;
    private final DepartmentService departmentService;
    private final OrgMemberService orgMemberService;
    private final OrgEventService orgEventService;
    private final MemberImportService memberImportService;

    public OrgAdminController(OrgPermissionService permission,
                              DepartmentService departmentService,
                              OrgMemberService orgMemberService,
                              OrgEventService orgEventService,
                              MemberImportService memberImportService) {
        this.permission = permission;
        this.departmentService = departmentService;
        this.orgMemberService = orgMemberService;
        this.orgEventService = orgEventService;
        this.memberImportService = memberImportService;
    }

    // ------------------------------------------------------------------ 部门

    @PostMapping("/departments")
    public ApiResponse<Department> createDepartment(@Valid @RequestBody DepartmentCreateRequest request) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(departmentService.create(actor, request));
    }

    @PatchMapping("/departments/{id}")
    public ApiResponse<Department> updateDepartment(@PathVariable Long id,
                                                    @Valid @RequestBody DepartmentUpdateRequest request) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(departmentService.update(actor, id, request));
    }

    @DeleteMapping("/departments/{id}")
    public ApiResponse<Void> deleteDepartment(@PathVariable Long id) {
        OrgMember actor = currentMember();
        departmentService.delete(actor, id);
        return ApiResponse.ok();
    }

    @PostMapping("/departments/{id}/managers")
    public ApiResponse<Void> grantManager(@PathVariable Long id,
                                          @Valid @RequestBody DeptManagerGrantRequest request) {
        OrgMember actor = currentMember();
        departmentService.grantManager(actor, id, request.orgMemberId());
        return ApiResponse.ok();
    }

    @DeleteMapping("/departments/{id}/managers/{orgMemberId}")
    public ApiResponse<Void> revokeManager(@PathVariable Long id, @PathVariable Long orgMemberId) {
        OrgMember actor = currentMember();
        departmentService.revokeManager(actor, id, orgMemberId);
        return ApiResponse.ok();
    }

    // ------------------------------------------------------------------ 成员

    @GetMapping("/members")
    public ApiResponse<java.util.List<OrgMemberResponse>> members() {
        OrgMember actor = currentMember();
        return ApiResponse.ok(orgMemberService.list(actor, null));
    }

    @PostMapping("/members")
    public ApiResponse<OrgMemberResponse> createMember(@Valid @RequestBody OrgMemberCreateRequest request) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(orgMemberService.create(actor, request));
    }

    @PatchMapping("/members/{id}")
    public ApiResponse<OrgMemberResponse> updateMember(@PathVariable Long id,
                                                       @Valid @RequestBody OrgMemberUpdateRequest request) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(orgMemberService.update(actor, id, request));
    }

    // -------------------------------------------------------------- 组织日程

    @PostMapping("/events")
    public ApiResponse<OrgEventResponse> dispatch(@Valid @RequestBody OrgEventDispatchRequest request) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(orgEventService.dispatch(actor, request));
    }

    @PostMapping("/events/{id}/revoke")
    public ApiResponse<Void> revoke(@PathVariable Long id) {
        OrgMember actor = currentMember();
        orgEventService.revoke(actor, id);
        return ApiResponse.ok();
    }

    @PatchMapping("/events/{id}")
    public ApiResponse<OrgEventResponse> updateEvent(@PathVariable Long id,
                                                     @Valid @RequestBody OrgEventUpdateRequest request) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(orgEventService.update(actor, id, request));
    }

    @DeleteMapping("/events/{id}")
    public ApiResponse<Void> deleteEvent(@PathVariable Long id) {
        OrgMember actor = currentMember();
        orgEventService.delete(actor, id);
        return ApiResponse.ok();
    }

    @GetMapping("/events/{id}/receipts")
    public ApiResponse<ReceiptSummaryResponse> receipts(@PathVariable Long id) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(orgEventService.receiptSummary(actor, id));
    }

    // -------------------------------------------------------------- 成员导入

    /**
     * 上传模板文件批量导入成员，立即返回 batchId，逐行结果异步产出。
     */
    @PostMapping(value = "/members/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<ImportBatchResponse> importMembers(
            @RequestPart("file") MultipartFile file,
            @RequestParam(defaultValue = "false") boolean autoCreateDepartment) throws IOException {
        OrgMember actor = currentMember();
        if (file.isEmpty()) {
            throw com.xatodo.common.exception.BizException.of(
                    com.xatodo.common.api.ErrorCode.PARAM_INVALID, "上传文件为空");
        }
        ImportBatch batch = memberImportService.startImport(
                actor, file.getOriginalFilename(), file.getBytes(), autoCreateDepartment);
        return ApiResponse.ok(memberImportService.detail(actor, batch.getId()));
    }

    @GetMapping("/members/import/template")
    public ResponseEntity<Resource> importTemplate() {
        currentMember();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"member-import-template.xlsx\"")
                .contentType(MediaType.parseMediaType(
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(new ByteArrayResource(memberImportService.template()));
    }

    @GetMapping("/imports")
    public ApiResponse<List<ImportBatch>> imports() {
        OrgMember actor = currentMember();
        return ApiResponse.ok(memberImportService.listBatches(actor));
    }

    @GetMapping("/imports/{id}")
    public ApiResponse<ImportBatchResponse> importDetail(@PathVariable Long id) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(memberImportService.detail(actor, id));
    }

    @GetMapping(value = "/imports/{id}/failures", produces = "text/csv;charset=UTF-8")
    public ResponseEntity<String> importFailures(@PathVariable Long id) {
        OrgMember actor = currentMember();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"import-failures-" + id + ".csv\"")
                .contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
                .body(memberImportService.failureCsv(actor, id));
    }

    private OrgMember currentMember() {
        return permission.requireMembership(CurrentIdentity.require());
    }
}
