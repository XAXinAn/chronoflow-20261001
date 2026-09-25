package com.xatodo.auth.web;

import com.xatodo.auth.dto.AuthDtos.DeviceResponse;
import com.xatodo.auth.dto.AuthDtos.NotificationPrefsRequest;
import com.xatodo.auth.dto.AuthDtos.SetPasswordRequest;
import com.xatodo.auth.dto.AuthDtos.UpdateProfileRequest;
import com.xatodo.auth.dto.IdentityView;
import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.auth.service.AccountService;
import com.xatodo.auth.service.AuthService;
import com.xatodo.common.api.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
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
}
