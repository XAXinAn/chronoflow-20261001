package com.xatodo.admin.web;

import com.xatodo.admin.dto.AdminDtos.AccountResponse;
import com.xatodo.admin.dto.AdminDtos.AccountStatusRequest;
import com.xatodo.admin.security.CurrentAdmin;
import com.xatodo.admin.service.AdminAccountService;
import com.xatodo.common.api.ApiResponse;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 平台账号管理（spec §4.4）。仅平台超管可访问。
 */
@RestController
@RequestMapping("/api/v1/admin")
@SecurityRequirement(name = "bearerAuth")
public class AdminAccountController {

    private final AdminAccountService adminAccountService;

    public AdminAccountController(AdminAccountService adminAccountService) {
        this.adminAccountService = adminAccountService;
    }

    @GetMapping("/accounts")
    public ApiResponse<List<AccountResponse>> search(@RequestParam(required = false) String phone,
                                                     @RequestParam(required = false) String status,
                                                     @RequestParam(defaultValue = "50") int limit) {
        CurrentAdmin.requireSuperAdmin();
        return ApiResponse.ok(adminAccountService.search(phone, status, limit));
    }

    @PostMapping("/accounts/{id}/status")
    public ApiResponse<AccountResponse> changeStatus(@PathVariable Long id,
                                                     @Valid @RequestBody AccountStatusRequest request) {
        return ApiResponse.ok(adminAccountService.changeStatus(
                CurrentAdmin.requireSuperAdmin(), id, request.status()));
    }

    @PostMapping("/identities/{id}/status")
    public ApiResponse<Void> changeIdentityStatus(@PathVariable Long id,
                                                  @Valid @RequestBody AccountStatusRequest request) {
        adminAccountService.changeIdentityStatus(CurrentAdmin.requireSuperAdmin(), id, request.status());
        return ApiResponse.ok();
    }

    @PostMapping("/accounts/{id}/force-logout")
    public ApiResponse<Void> forceLogout(@PathVariable Long id) {
        adminAccountService.forceLogout(CurrentAdmin.requireSuperAdmin(), id);
        return ApiResponse.ok();
    }
}
