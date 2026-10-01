package com.chronoflow.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.Map;
import java.time.OffsetDateTime;

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
            @NotBlank(message = "验证码不能为空") String code,
            /** 设备标识：令牌与设备绑定（单身份最多 5 台，spec §3.5） */
            @NotBlank(message = "deviceId 不能为空") String deviceId) {
    }

    /**
     * 登录结果（spec §3.2）：**App 只登录个人账号**。
     *
     * <ul>
     *   <li>还没有个人身份 → `needRegister=true` + `registerToken`，引导创建个人身份；</li>
     *   <li>已有个人身份 → 直接给出该身份的令牌对（`session`），不再有「选身份」这一步。</li>
     * </ul>
     */
    public record SmsLoginResponse(boolean needRegister,
                                   String registerToken,
                                   TokenResponse session) {

        public static SmsLoginResponse register(String registerToken) {
            return new SmsLoginResponse(true, registerToken, null);
        }

        public static SmsLoginResponse loggedIn(TokenResponse session) {
            return new SmsLoginResponse(false, null, session);
        }
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

    // ------------------------------------------------------------ 账号设置

    public record UpdateProfileRequest(@Size(max = 32, message = "昵称最长 32 个字符") String nickname,
                                       @Size(max = 512) String avatarUrl,
                                       @Size(max = 64) String timezone) {
    }

    public record SetPasswordRequest(@Size(max = 64) String oldPassword,
                                     @NotBlank(message = "新密码不能为空")
                                     @Size(min = 8, max = 64, message = "密码长度需在 8-64 之间") String newPassword) {
    }

    public record PasswordLoginRequest(
            @NotBlank(message = "手机号不能为空")
            @Pattern(regexp = PHONE_PATTERN, message = "手机号格式不正确") String phone,
            @NotBlank(message = "密码不能为空") String password,
            @NotBlank(message = "deviceId 不能为空") String deviceId) {
    }

    public record NotificationPrefsRequest(
            @NotNull(message = "prefs 不能为空") Map<String, Boolean> prefs) {
    }

    public record DeviceResponse(String deviceId, OffsetDateTime issuedAt) {
    }
}
