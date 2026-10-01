package com.chronoflow.auth.web;

import com.chronoflow.auth.dto.AuthDtos.CreatePersonalIdentityRequest;
import com.chronoflow.auth.dto.AuthDtos.TokenResponse;
import com.chronoflow.auth.security.TokenScope;
import com.chronoflow.auth.service.AuthService;
import com.chronoflow.auth.service.TokenService;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 首次登录后创建个人身份，对应 spec §3.2「无身份 → 引导创建个人身份」。
 *
 * <p>使用登录接口下发的 REGISTER 令牌鉴权（请求头 {@code Authorization: Bearer <registerToken>}）。
 */
@RestController
@RequestMapping("/api/v1/identities")
public class PersonalIdentityController {

    private final AuthService authService;
    private final TokenService tokenService;

    public PersonalIdentityController(AuthService authService, TokenService tokenService) {
        this.authService = authService;
        this.tokenService = tokenService;
    }

    @PostMapping("/personal")
    public ApiResponse<TokenResponse> create(@Valid @RequestBody CreatePersonalIdentityRequest request,
                                             @RequestHeader(value = "Authorization", required = false) String authorization) {
        String token = extractBearer(authorization);
        Long accountId = tokenService.parseScopedToken(token, TokenScope.REGISTER);
        return ApiResponse.ok(authService.createPersonalIdentity(
                accountId, request.nickname(), request.avatarUrl(), request.deviceId()));
    }

    private String extractBearer(String authorization) {
        if (authorization == null || !authorization.startsWith("Bearer ")) {
            throw BizException.of(ErrorCode.UNAUTHENTICATED);
        }
        return authorization.substring("Bearer ".length()).trim();
    }
}
