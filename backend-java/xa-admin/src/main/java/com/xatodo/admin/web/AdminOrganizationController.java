package com.xatodo.admin.web;

import com.xatodo.admin.dto.AdminDtos.OrganizationCreateRequest;
import com.xatodo.admin.dto.AdminDtos.OrganizationResponse;
import com.xatodo.admin.dto.AdminDtos.OrganizationStatusRequest;
import com.xatodo.admin.dto.AdminDtos.OrganizationUpdateRequest;
import com.xatodo.admin.security.CurrentAdmin;
import com.xatodo.admin.service.AdminOrganizationService;
import com.xatodo.common.api.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 组织（租户）管理（spec §4.4）。仅平台超管可访问。
 */
@RestController
@RequestMapping("/api/v1/admin/organizations")
public class AdminOrganizationController {

    private final AdminOrganizationService organizationService;

    public AdminOrganizationController(AdminOrganizationService organizationService) {
        this.organizationService = organizationService;
    }

    @GetMapping
    public ApiResponse<List<OrganizationResponse>> list() {
        return ApiResponse.ok(organizationService.list(CurrentAdmin.requireSuperAdmin()));
    }

    @PostMapping
    public ApiResponse<OrganizationResponse> create(@Valid @RequestBody OrganizationCreateRequest request) {
        return ApiResponse.ok(organizationService.create(CurrentAdmin.requireSuperAdmin(), request));
    }

    @GetMapping("/{id}")
    public ApiResponse<OrganizationResponse> get(@PathVariable Long id) {
        return ApiResponse.ok(organizationService.get(CurrentAdmin.requireSuperAdmin(), id));
    }

    @PatchMapping("/{id}")
    public ApiResponse<OrganizationResponse> update(@PathVariable Long id,
                                                    @Valid @RequestBody OrganizationUpdateRequest request) {
        return ApiResponse.ok(organizationService.update(CurrentAdmin.requireSuperAdmin(), id, request));
    }

    @PostMapping("/{id}/status")
    public ApiResponse<OrganizationResponse> changeStatus(@PathVariable Long id,
                                                          @Valid @RequestBody OrganizationStatusRequest request) {
        return ApiResponse.ok(organizationService.changeStatus(
                CurrentAdmin.requireSuperAdmin(), id, request.status()));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        organizationService.delete(CurrentAdmin.requireSuperAdmin(), id);
        return ApiResponse.ok();
    }
}
