package com.chronoflow.auth.sms;

/**
 * 短信发送通道（spec §3.6）。
 *
 * <p>验证码的生成与校验与「怎么发出去」是两件事：{@code VerificationCodeService} 只管前者，
 * 通道由这里抽象。开发环境用 {@link LoggingSmsSender}（不真发，配合 {@code expose-sms-code} 回显），
 * 部署环境用 {@link AliyunSmsSender}。
 */
public interface SmsSender {

    /**
     * 发送验证码短信。
     *
     * <p>失败必须抛异常：调用方会据此清掉验证码与频控锁，让用户能立刻重试，
     * 而不是等 60 秒后又失败一次。
     */
    void sendVerificationCode(String phone, String code);
}
