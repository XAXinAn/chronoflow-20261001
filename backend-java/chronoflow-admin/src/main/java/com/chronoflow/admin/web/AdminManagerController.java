package com.chronoflow.admin.web;

import com.chronoflow.admin.dto.AdminDtos.AdminCreateRequest;
import com.chronoflow.admin.dto.AdminDtos.AdminInfo;
import com.chronoflow.admin.dto.AdminDtos.AdminUpdateRequest;
import com.chronoflow.admin.dto.AdminDtos.ResetPasswordRequest;
import com.chronoflow.admin.security.CurrentAdmin;
import com.chronoflow.admin.service.AdminAuthService;
import com.chronoflow.common.api.ApiResponse;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 后台管理员管理（spec §4.4）。写操作仅超管可用。
 */
@RestController
@RequestMapping("/api/v1/admin/admins")
@SecurityRequirement(name = "bearerAuth")
public class AdminManagerController {

    private final AdminAuthService adminAuthService;

    public AdminManagerController(AdminAuthService adminAuthService) {
        this.adminAuthService = adminAuthService;
    }

    @GetMapping
    public ApiResponse<List<AdminInfo>> list() {
        return ApiResponse.ok(adminAuthService.list(CurrentAdmin.require()));
    }

    @PostMapping
    public ApiResponse<AdminInfo> create(@Valid @RequestBody AdminCreateRequest request) {
        return ApiResponse.ok(adminAuthService.create(CurrentAdmin.require(), request));
    }

    @PatchMapping("/{id}")
    public ApiResponse<AdminInfo> update(@PathVariable Long id,
                                         @Valid @RequestBody AdminUpdateRequest request) {
        return ApiResponse.ok(adminAuthService.update(CurrentAdmin.require(), id, request));
    }

    @PostMapping("/{id}/reset-password")
    public ApiResponse<Void> resetPassword(@PathVariable Long id,
                                           @Valid @RequestBody ResetPasswordRequest request) {
        adminAuthService.resetPassword(CurrentAdmin.require(), id, request);
        return ApiResponse.ok();
    }
}
