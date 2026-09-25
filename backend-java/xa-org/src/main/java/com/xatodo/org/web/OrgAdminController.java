package com.xatodo.org.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.org.dto.OrgDtos.DepartmentCreateRequest;
import com.xatodo.org.dto.OrgDtos.DepartmentUpdateRequest;
import com.xatodo.org.dto.OrgDtos.DeptManagerGrantRequest;
import com.xatodo.org.dto.OrgDtos.OrgEventDispatchRequest;
import com.xatodo.org.dto.OrgDtos.OrgEventResponse;
import com.xatodo.org.dto.OrgDtos.OrgMemberCreateRequest;
import com.xatodo.org.dto.OrgDtos.OrgMemberResponse;
import com.xatodo.org.dto.OrgDtos.OrgMemberUpdateRequest;
import com.xatodo.org.dto.OrgDtos.ReceiptSummaryResponse;
import com.xatodo.org.entity.Department;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.service.DepartmentService;
import com.xatodo.org.service.OrgEventService;
import com.xatodo.org.service.OrgMemberService;
import com.xatodo.org.service.OrgPermissionService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

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

    public OrgAdminController(OrgPermissionService permission,
                              DepartmentService departmentService,
                              OrgMemberService orgMemberService,
                              OrgEventService orgEventService) {
        this.permission = permission;
        this.departmentService = departmentService;
        this.orgMemberService = orgMemberService;
        this.orgEventService = orgEventService;
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

    @GetMapping("/events/{id}/receipts")
    public ApiResponse<ReceiptSummaryResponse> receipts(@PathVariable Long id) {
        OrgMember actor = currentMember();
        return ApiResponse.ok(orgEventService.receiptSummary(actor, id));
    }

    private OrgMember currentMember() {
        return permission.requireMembership(CurrentIdentity.require());
    }
}
