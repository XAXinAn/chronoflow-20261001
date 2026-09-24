package com.xatodo.auth.web;

import com.xatodo.auth.dto.AuthDtos.IdentitySelectRequest;
import com.xatodo.auth.dto.AuthDtos.LogoutRequest;
import com.xatodo.auth.dto.AuthDtos.RefreshTokenRequest;
import com.xatodo.auth.dto.AuthDtos.SendSmsCodeRequest;
import com.xatodo.auth.dto.AuthDtos.SendSmsCodeResponse;
import com.xatodo.auth.dto.AuthDtos.SmsLoginRequest;
import com.xatodo.auth.dto.AuthDtos.SmsLoginResponse;
import com.xatodo.auth.dto.AuthDtos.SwitchIdentityRequest;
import com.xatodo.auth.dto.AuthDtos.TokenResponse;
import com.xatodo.auth.dto.IdentityView;
import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.auth.security.TokenScope;
import com.xatodo.auth.service.AuthService;
import com.xatodo.auth.service.TokenService;
import com.xatodo.auth.service.VerificationCodeService;
import com.xatodo.common.api.ApiResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 认证接口，对应 spec §6.2「认证」分组。
 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;
    private final VerificationCodeService verificationCodeService;
    private final TokenService tokenService;

    public AuthController(AuthService authService,
                          VerificationCodeService verificationCodeService,
                          TokenService tokenService) {
        this.authService = authService;
        this.verificationCodeService = verificationCodeService;
        this.tokenService = tokenService;
    }

    @PostMapping("/sms/code")
    public ApiResponse<SendSmsCodeResponse> sendSmsCode(@Valid @RequestBody SendSmsCodeRequest request,
                                                       HttpServletRequest servletRequest) {
        return ApiResponse.ok(verificationCodeService.send(request.phone(), resolveClientIp(servletRequest)));
    }

    @PostMapping("/login/sms")
    public ApiResponse<SmsLoginResponse> loginBySms(@Valid @RequestBody SmsLoginRequest request) {
        return ApiResponse.ok(authService.loginBySms(request.phone(), request.code()));
    }

    /**
     * 登录后选择身份。selectToken 为 {@code /auth/login/sms} 返回的临时令牌。
     */
    @PostMapping("/identity/select")
    public ApiResponse<TokenResponse> selectIdentity(@Valid @RequestBody IdentitySelectRequest request) {
        Long accountId = tokenService.parseScopedToken(request.selectToken(), TokenScope.IDENTITY_SELECT);
        return ApiResponse.ok(authService.selectIdentity(accountId, request.identityId(), request.deviceId()));
    }

    @PostMapping("/identity/switch")
    public ApiResponse<TokenResponse> switchIdentity(@Valid @RequestBody SwitchIdentityRequest request) {
        return ApiResponse.ok(authService.switchIdentity(
                request.refreshToken(), request.targetIdentityId(), request.deviceId()));
    }

    @PostMapping("/token/refresh")
    public ApiResponse<TokenResponse> refresh(@Valid @RequestBody RefreshTokenRequest request) {
        return ApiResponse.ok(authService.refresh(request.refreshToken(), request.deviceId()));
    }

    @PostMapping("/logout")
    public ApiResponse<Void> logout(@RequestBody(required = false) LogoutRequest request) {
        if (request != null) {
            authService.logout(request.refreshToken());
        }
        return ApiResponse.ok();
    }

    /**
     * 当前账号下的全部身份（需要已选定身份的访问令牌）。
     */
    @GetMapping("/identities")
    public ApiResponse<List<IdentityView>> identities() {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(authService.listIdentities(principal.accountId()));
    }

    private String resolveClientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}
