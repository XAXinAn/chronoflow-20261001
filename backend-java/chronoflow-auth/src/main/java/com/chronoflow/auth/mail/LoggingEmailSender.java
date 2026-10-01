package com.chronoflow.auth.mail;

import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * 开发环境的邮件通道：**不真发**，只打一行日志（验证码本体不落日志）。
 *
 * <p>要拿到码，靠 {@code chronoflow.auth.expose-mail-code=true} 让接口回显——
 * 与短信的 {@code expose-sms-code} 是同一套规矩：能在响应里回显**只在没接真通道时**成立。
 */
@Component
@ConditionalOnProperty(name = "chronoflow.auth.mail.provider", havingValue = "log", matchIfMissing = true)
public class LoggingEmailSender implements EmailSender {

    private static final Logger log = LoggerFactory.getLogger(LoggingEmailSender.class);

    @Value("${chronoflow.auth.expose-mail-code:false}")
    private boolean exposeCode;

    @Override
    public void sendVerificationCode(String email, String code) {
        if (!exposeCode) {
            // 没接真通道又没开回显 = 用户永远收不到码，还不如当场说清楚
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "邮件通道未配置（开发环境请设置 chronoflow.auth.expose-mail-code=true）");
        }
        log.info("邮箱验证码已生成（开发通道，不真发） email={} code={}", mask(email), code);
    }

    private String mask(String email) {
        int at = email == null ? -1 : email.indexOf('@');
        if (at <= 1) {
            return "***";
        }
        return email.charAt(0) + "***" + email.substring(at);
    }
}
