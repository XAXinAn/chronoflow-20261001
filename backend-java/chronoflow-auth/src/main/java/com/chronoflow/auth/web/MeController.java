package com.chronoflow.auth.web;

import com.chronoflow.auth.dto.AuthDtos.DeviceResponse;
import com.chronoflow.auth.dto.AuthDtos.NotificationPrefsRequest;
import com.chronoflow.auth.dto.AuthDtos.SetPasswordRequest;
import com.chronoflow.auth.dto.AuthDtos.UpdateProfileRequest;
import com.chronoflow.auth.dto.IdentityView;
import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.auth.security.IdentityPrincipal;
import com.chronoflow.auth.service.AccountService;
import com.chronoflow.auth.service.AuthService;
import com.chronoflow.common.api.ApiResponse;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 账号设置，对应 spec §6.2「账号设置」分组。
 *
 * <p>所有操作都作用于**当前身份所属的账号**，账号与身份从令牌解析，不接受请求体传参。
 */
@RestController
@RequestMapping("/api/v1/me")
@SecurityRequirement(name = "bearerAuth")
public class MeController {

    private final AuthService authService;
    private final AccountService accountService;

    public MeController(AuthService authService, AccountService accountService) {
        this.authService = authService;
        this.accountService = accountService;
    }

    @GetMapping
    public ApiResponse<IdentityView> me() {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(authService.currentIdentityView(principal.accountId(), principal.identityId()));
    }

    @PatchMapping
    public ApiResponse<IdentityView> updateProfile(@Valid @RequestBody UpdateProfileRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        accountService.updateProfile(principal.identityId(), request);
        return ApiResponse.ok(authService.currentIdentityView(principal.accountId(), principal.identityId()));
    }

    /**
     * 设置或修改密码。账号已有密码时必须提供原密码。
     */
    @PutMapping("/password")
    public ApiResponse<Void> setPassword(@Valid @RequestBody SetPasswordRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        accountService.setPassword(principal.accountId(), request);
        return ApiResponse.ok();
    }

    @GetMapping("/devices")
    public ApiResponse<List<DeviceResponse>> devices() {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(accountService.devices(principal.identityId()));
    }

    @DeleteMapping("/devices/{deviceId}")
    public ApiResponse<Void> revokeDevice(@PathVariable String deviceId) {
        IdentityPrincipal principal = CurrentIdentity.require();
        accountService.revokeDevice(principal.identityId(), deviceId);
        return ApiResponse.ok();
    }

    @PutMapping("/notifications")
    public ApiResponse<Map<String, Boolean>> updateNotifications(
            @Valid @RequestBody NotificationPrefsRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(accountService.updateNotificationPrefs(principal.identityId(), request.prefs()));
    }

    /**
     * 自助注销账号（商店规范 §2.7：App 内必须有对应的注销功能按钮）。
     *
     * <p>注销后本设备与所有其他设备的令牌同时失效，App 侧调完这个接口必须清掉本地会话。
     * 这里用 POST 而不是 DELETE：它不是「删掉一个资源」，而是一次不可逆的账号处置动作，
     * 与 {@code /admin/accounts/{id}/status} 保持同一风格。
     */
    @PostMapping("/deletion")
    public ApiResponse<Void> deleteAccount() {
        IdentityPrincipal principal = CurrentIdentity.require();
        accountService.deleteAccount(principal.accountId());
        return ApiResponse.ok();
    }
}
