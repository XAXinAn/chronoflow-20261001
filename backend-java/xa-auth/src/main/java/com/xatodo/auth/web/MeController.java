package com.xatodo.auth.web;

import com.xatodo.auth.dto.IdentityView;
import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.auth.service.AuthService;
import com.xatodo.common.api.ApiResponse;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 当前身份信息，对应 spec §6.2「账号设置」分组。
 */
@RestController
@RequestMapping("/api/v1/me")
public class MeController {

    private final AuthService authService;

    public MeController(AuthService authService) {
        this.authService = authService;
    }

    @GetMapping
    public ApiResponse<IdentityView> me() {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(authService.currentIdentityView(principal.accountId(), principal.identityId()));
    }
}
