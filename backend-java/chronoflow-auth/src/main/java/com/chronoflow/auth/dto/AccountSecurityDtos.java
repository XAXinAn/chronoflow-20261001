package com.chronoflow.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 「账号与安全」（spec §6.2）：实名认证与邮箱绑定的请求 / 响应。
 *
 * <p>身份证号只在这一层出现：入口校验 → 立刻加密 + 取指纹 → 明文不再向下传。
 */
public final class AccountSecurityDtos {

    private AccountSecurityDtos() {
    }

    /** 发邮箱验证码。邮箱格式在这里挡掉，别让明显错的地址走到 DirectMail。 */
    public record SendEmailCodeRequest(
            @NotBlank @Email @Size(max = 128) String email) {
    }

    /** 绑定 / 改绑邮箱：邮箱 + 刚收到的 6 位验证码。 */
    public record BindEmailRequest(
            @NotBlank @Email @Size(max = 128) String email,
            @NotBlank @Pattern(regexp = "\\d{6}", message = "验证码是 6 位数字") String code) {
    }

    /** 发起实名认证：姓名 + 身份证号（老项目是注册时强制，我们做成登录后可选）。 */
    public record RealNameRequest(
            @NotBlank @Size(min = 2, max = 32, message = "请输入真实姓名") String realName,
            @NotBlank @Pattern(regexp = "\\d{17}[\\dXx]", message = "请输入 18 位身份证号") String idCardNumber) {
    }

    public record EmailCodeResponse(long expiresIn, String debugCode) {
    }

    /** 认证页地址与凭据：App 用 WebView 打开 certifyUrl，完成后拿 certifyId 回来查结果。 */
    public record RealNameInitResponse(String certifyId, String certifyUrl) {
    }

    public record RealNameResultResponse(boolean verified, String message) {
    }

    /** 「账号与安全」页要展示的东西：邮箱、是否已验证、是否已实名、实名姓名。 */
    public record AccountSecurityView(
            String email,
            boolean emailVerified,
            boolean realNameVerified,
            String realName) {
    }
}
