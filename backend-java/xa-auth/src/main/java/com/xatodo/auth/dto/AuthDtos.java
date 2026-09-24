package com.xatodo.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * 认证相关请求 / 响应体。集中定义以便与 spec §6.2 的接口清单对照。
 */
public final class AuthDtos {

    private AuthDtos() {
    }

    public static final String PHONE_PATTERN = "^1[3-9]\\d{9}$";

    public record SendSmsCodeRequest(
            @NotBlank(message = "手机号不能为空")
            @Pattern(regexp = PHONE_PATTERN, message = "手机号格式不正确")
            String phone) {
    }

    public record SendSmsCodeResponse(long expiresIn, String debugCode) {
    }

    public record SmsLoginRequest(
            @NotBlank(message = "手机号不能为空")
            @Pattern(regexp = PHONE_PATTERN, message = "手机号格式不正确")
            String phone,
            @NotBlank(message = "验证码不能为空") String code) {
    }

    /**
     * 登录结果：首次登录需要创建个人身份；已有身份则需要选择。
     */
    public record SmsLoginResponse(boolean needRegister,
                                   String registerToken,
                                   boolean needSelectIdentity,
                                   String selectToken,
                                   List<IdentityView> identities) {
    }

    public record IdentitySelectRequest(
            @NotBlank(message = "selectToken 不能为空") String selectToken,
            @NotNull(message = "identityId 不能为空") Long identityId,
            String deviceId,
            String deviceName) {
    }

    public record CreatePersonalIdentityRequest(
            @Size(max = 32, message = "昵称最长 32 个字符") String nickname,
            @Size(max = 512) String avatarUrl,
            String deviceId,
            String deviceName) {
    }

    public record RefreshTokenRequest(
            @NotBlank(message = "refreshToken 不能为空") String refreshToken,
            String deviceId) {
    }

    public record SwitchIdentityRequest(
            @NotBlank(message = "refreshToken 不能为空") String refreshToken,
            @NotNull(message = "targetIdentityId 不能为空") Long targetIdentityId,
            String deviceId) {
    }

    public record LogoutRequest(String refreshToken) {
    }

    public record IdentitySummary(Long accountId,
                                  Long identityId,
                                  String identityType,
                                  Long orgId,
                                  String nickname,
                                  String avatarUrl) {
    }

    public record TokenResponse(String accessToken,
                                String refreshToken,
                                long expiresIn,
                                IdentitySummary identity) {
    }
}
