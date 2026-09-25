package com.xatodo.admin.web;

import com.xatodo.admin.dto.AdminDtos.AdminInfo;
import com.xatodo.admin.dto.AdminDtos.AdminLoginRequest;
import com.xatodo.admin.dto.AdminDtos.AdminLoginResponse;
import com.xatodo.admin.dto.AdminDtos.ChangePasswordRequest;
import com.xatodo.admin.security.CurrentAdmin;
import com.xatodo.admin.service.AdminAuthService;
import com.xatodo.common.api.ApiResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 后台登录与当前管理员信息，对应 spec §6.3「公共」分组。
 */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminAuthController {

    private final AdminAuthService adminAuthService;

    public AdminAuthController(AdminAuthService adminAuthService) {
        this.adminAuthService = adminAuthService;
    }

    @PostMapping("/auth/login")
    public ApiResponse<AdminLoginResponse> login(@Valid @RequestBody AdminLoginRequest request,
                                                 HttpServletRequest servletRequest) {
        return ApiResponse.ok(adminAuthService.login(request, resolveClientIp(servletRequest),
                servletRequest.getHeader("User-Agent")));
    }

    @GetMapping("/me")
    public ApiResponse<AdminInfo> me() {
        return ApiResponse.ok(adminAuthService.me(CurrentAdmin.require()));
    }

    @PutMapping("/me/password")
    public ApiResponse<Void> changePassword(@Valid @RequestBody ChangePasswordRequest request) {
        adminAuthService.changePassword(CurrentAdmin.require(), request);
        return ApiResponse.ok();
    }

    private String resolveClientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}
