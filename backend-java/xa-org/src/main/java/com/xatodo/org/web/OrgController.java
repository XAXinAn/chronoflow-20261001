package com.xatodo.org.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.org.dto.OrgDtos.DepartmentNode;
import com.xatodo.org.dto.OrgDtos.OrgCurrentResponse;
import com.xatodo.org.dto.OrgDtos.OrgEventResponse;
import com.xatodo.org.dto.OrgDtos.OrgMemberResponse;
import com.xatodo.org.dto.OrgDtos.ReceiptItem;
import com.xatodo.org.dto.OrgDtos.ReceiptRequest;
import com.xatodo.org.dto.OrgDtos.ReceiptSummaryResponse;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.service.DepartmentService;
import com.xatodo.org.service.OrgEventService;
import com.xatodo.org.service.OrgMemberService;
import com.xatodo.org.service.OrgPermissionService;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 组织端（App）接口，对应 spec §6.2「组织（组织身份）」分组。
 */
@RestController
@RequestMapping("/api/v1/org")
@SecurityRequirement(name = "bearerAuth")
public class OrgController {

    private final OrgPermissionService permission;
    private final DepartmentService departmentService;
    private final OrgMemberService orgMemberService;
    private final OrgEventService orgEventService;

    public OrgController(OrgPermissionService permission,
                         DepartmentService departmentService,
                         OrgMemberService orgMemberService,
                         OrgEventService orgEventService) {
        this.permission = permission;
        this.departmentService = departmentService;
        this.orgMemberService = orgMemberService;
        this.orgEventService = orgEventService;
    }

    @GetMapping("/current")
    public ApiResponse<OrgCurrentResponse> current() {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(orgMemberService.current(principal));
    }

    @GetMapping("/departments/tree")
    public ApiResponse<List<DepartmentNode>> departmentTree() {
        OrgMember member = currentMember();
        return ApiResponse.ok(departmentService.tree(member.getOrgId()));
    }

    @GetMapping("/members")
    public ApiResponse<List<OrgMemberResponse>> members(@RequestParam(required = false) Long departmentId) {
        OrgMember member = currentMember();
        return ApiResponse.ok(orgMemberService.list(member, departmentId));
    }

    /**
     * 成员视角的组织日程：只返回下发给本人的日程，附回执状态。
     */
    @GetMapping("/events")
    public ApiResponse<List<OrgEventResponse>> events(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime start,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime end) {
        OrgMember member = currentMember();
        return ApiResponse.ok(orgEventService.listForMember(member, start.toInstant(), end.toInstant()));
    }

    @PostMapping("/events/{id}/receipt")
    public ApiResponse<OrgEventResponse> receipt(@PathVariable Long id,
                                                 @Valid @RequestBody ReceiptRequest request) {
        OrgMember member = currentMember();
        return ApiResponse.ok(orgEventService.submitReceipt(member, id, request));
    }

    @PostMapping("/events/{id}/read")
    public ApiResponse<Void> markRead(@PathVariable Long id) {
        OrgMember member = currentMember();
        orgEventService.markRead(member, id);
        return ApiResponse.ok();
    }

    @GetMapping("/events/{id}/recipients")
    public ApiResponse<ReceiptSummaryResponse> recipients(@PathVariable Long id) {
        OrgMember member = currentMember();
        return ApiResponse.ok(orgEventService.receiptSummary(member, id));
    }

    /**
     * 便捷接口：当前成员可见的回执条目（等价于回执统计中的 items）。
     */
    @GetMapping("/events/{id}/recipients/mine")
    public ApiResponse<ReceiptItem> myRecipient(@PathVariable Long id) {
        OrgMember member = currentMember();
        ReceiptSummaryResponse summary = orgEventService.receiptSummary(member, id);
        return ApiResponse.ok(summary.items().stream()
                .filter(item -> item.orgMemberId().equals(member.getId()))
                .findFirst()
                .orElse(null));
    }

    private OrgMember currentMember() {
        return permission.requireMembership(CurrentIdentity.require());
    }
}
