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
            @NotBlank @Pattern(regexp = "\\d{17}[\\dXx]", message = "请输入 18 位身份证号") String idCardNumber,
            /**
             * 客户端 Web SDK（`jsvm_all.js` 的 `window.getMetaInfo()`）采集的环境参数。
             *
             * <p>**必填且必须实时获取**：阿里云靠它识别设备类型并签发匹配的 `CertifyUrl`；
             * 官方说明原文「此参数需要入参中 MetaInfo 正确传入，以返回与客户端匹配的 CertifyUrl」，
             * 并且明确「禁止使用硬编码的测试数据，否则可能导致无法获取 CertifyUrl」。
             */
            @NotBlank(message = "缺少客户端环境参数") String metaInfo) {
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
            /** 手机号（登录凭证）：这四项都是**账号级**信息，「我的」页头部要直接展示 */
            String phone,
            String email,
            boolean emailVerified,
            boolean realNameVerified,
            String realName) {
    }

    /** 换绑手机号第一步：给某个号码发验证码（旧号与新号各要一次）。 */
    public record SendPhoneCodeRequest(
            @NotBlank @Pattern(regexp = "1\\d{10}", message = "手机号格式不正确") String phone) {
    }

    /**
     * 换绑手机号第二步：**两个验证码都要给**。
     *
     * <p>只验新号是不够的：拿到 access token 的人就能把手机号换成自己的，等于把账号偷走。
     * 所以旧号也要验一次（证明是本人），新号验证证明新号码可用。
     */
    public record ChangePhoneRequest(
            @NotBlank @Pattern(regexp = "1\\d{10}", message = "手机号格式不正确") String newPhone,
            @NotBlank @Pattern(regexp = "\\d{6}", message = "验证码是 6 位数字") String newCode,
            @NotBlank @Pattern(regexp = "\\d{6}", message = "验证码是 6 位数字") String oldCode) {
    }
}
