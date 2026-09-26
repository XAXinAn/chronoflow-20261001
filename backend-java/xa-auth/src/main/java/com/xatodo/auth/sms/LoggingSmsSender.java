package com.xatodo.auth.sms;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * 开发/测试用的「不发真短信」通道：验证码只写进存储，
 * 开发环境再靠 {@code xatodo.auth.expose-sms-code=true} 在响应里回显。
 */
@Component
@ConditionalOnProperty(name = "xatodo.auth.sms.provider", havingValue = "log", matchIfMissing = true)
public class LoggingSmsSender implements SmsSender {

    private static final Logger log = LoggerFactory.getLogger(LoggingSmsSender.class);

    @Override
    public void sendVerificationCode(String phone, String code) {
        // 故意不记验证码本身：日志是要给人看的，不是给攻击者看的
        log.info("短信通道未启用（xatodo.auth.sms.provider=log），验证码只写入存储 phone={}", mask(phone));
    }

    private String mask(String phone) {
        return phone != null && phone.length() >= 7
                ? phone.substring(0, 3) + "****" + phone.substring(phone.length() - 4)
                : "***";
    }
}
