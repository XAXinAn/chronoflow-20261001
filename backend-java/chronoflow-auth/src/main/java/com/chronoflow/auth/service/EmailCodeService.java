package com.chronoflow.auth.service;

import com.chronoflow.auth.mail.EmailSender;
import com.chronoflow.auth.store.VerificationCodeStore;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.Duration;

/**
 * 邮箱验证码的生成与校验（邮箱绑定 / 改绑，spec §6.2「账号与安全」）。
 *
 * <p>与短信验证码是同一套规矩，照抄 {@code VerificationCodeService} 的节奏而不是另发明一套：
 * 6 位数字、10 分钟有效、同邮箱 60 秒 1 条、连错 5 次作废。
 *
 * <p>存储复用 {@link VerificationCodeStore}：它是「按一个字符串键存码 + 频控 + 失败计数」的
 * 通用实现，键就是传进去的那个值（这里用邮箱）。**不另建一套 store**，免得两边的频控规则漂移。
 */
@Service
public class EmailCodeService {

    private static final Logger log = LoggerFactory.getLogger(EmailCodeService.class);
    private static final Duration CODE_TTL = Duration.ofMinutes(10);
    private static final Duration SEND_LOCK_TTL = Duration.ofSeconds(60);
    private static final Duration FAILURE_TTL = Duration.ofMinutes(10);
    private static final int MAX_VERIFY_FAILURES = 5;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final VerificationCodeStore store;
    private final EmailSender sender;

    /** 与短信的 expose-sms-code 同一套：**只在没接真通道时**才允许回显，接了真通道永不回显。 */
    @Value("${chronoflow.auth.expose-mail-code:false}")
    private boolean exposeCode;

    public EmailCodeService(VerificationCodeStore store, EmailSender sender) {
        this.store = store;
        this.sender = sender;
    }

    /** 发码。返回有效期秒数与**开发环境**下才有的回显码。 */
    public SendResult send(String email) {
        if (!store.tryAcquireSendLock(email, SEND_LOCK_TTL)) {
            throw BizException.of(ErrorCode.SMS_SEND_TOO_FREQUENT, "验证码发送过于频繁，请稍后再试");
        }
        String code = String.format("%06d", RANDOM.nextInt(1_000_000));
        try {
            sender.sendVerificationCode(email, code);
        } catch (RuntimeException ex) {
            // 没发出去就不要把用户锁在 60 秒频控里——与短信完全一致的取舍
            store.releaseSendLock(email);
            store.deleteCode(email);
            throw ex;
        }
        store.saveCode(email, code, CODE_TTL);
        log.info("邮箱验证码已发出");
        return new SendResult(CODE_TTL.toSeconds(), exposeCode ? code : null);
    }

    /** 校验并**立即作废**（一次性）。 */
    public void verify(String email, String code) {
        String expected = store.findCode(email).orElse(null);
        if (expected == null) {
            throw BizException.of(ErrorCode.SMS_CODE_INVALID, "验证码已过期，请重新获取");
        }
        if (!expected.equals(code)) {
            long failures = store.incrementVerifyFailure(email, FAILURE_TTL);
            if (failures >= MAX_VERIFY_FAILURES) {
                store.deleteCode(email);
                store.clearVerifyFailure(email);
            }
            throw BizException.of(ErrorCode.SMS_CODE_INVALID, "验证码不正确");
        }
        store.deleteCode(email);
        store.clearVerifyFailure(email);
    }

    public record SendResult(long expiresIn, String debugCode) {
    }
}
