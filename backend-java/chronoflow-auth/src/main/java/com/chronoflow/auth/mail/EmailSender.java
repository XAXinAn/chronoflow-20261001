package com.chronoflow.auth.mail;

/**
 * 邮件发送通道（spec §6.2「账号与安全」里的邮箱绑定）。
 *
 * <p>与短信一样，把「发出去」和「验证码怎么生成 / 校验」分开：
 * {@code EmailCodeService} 管后者，通道由这里抽象。开发环境用 {@link LoggingEmailSender}
 * （不真发，配合回显调试码），部署环境用 {@link AliyunDirectMailSender}。
 *
 * <p>失败必须抛异常：调用方会据此清掉验证码与频控锁，让用户能立刻重试。
 */
public interface EmailSender {

    /** 发送邮箱验证码。@param email 收件地址 */
    void sendVerificationCode(String email, String code);
}
