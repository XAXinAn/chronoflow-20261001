package com.xatodo.auth.service;

import com.xatodo.auth.config.AuthProperties;
import com.xatodo.auth.dto.AuthDtos;
import com.xatodo.auth.dto.AuthDtos.SendSmsCodeResponse;
import com.xatodo.auth.store.VerificationCodeStore;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.Duration;
import java.util.regex.Pattern;

/**
 * 短信验证码的发送与校验，规则见 spec §3.6。
 *
 * <p>当前未接入真实短信通道：验证码只写入存储。开发环境下可由配置
 * {@code xatodo.auth.expose-sms-code=true} 在响应中回显，便于联调与自动化测试。
 */
@Service
public class VerificationCodeService {

    private static final Logger log = LoggerFactory.getLogger(VerificationCodeService.class);
    private static final Pattern PHONE = Pattern.compile(AuthDtos.PHONE_PATTERN);
    private static final Duration DAILY_WINDOW = Duration.ofDays(1);

    private final VerificationCodeStore store;
    private final AuthProperties properties;
    private final SecureRandom random = new SecureRandom();

    public VerificationCodeService(VerificationCodeStore store, AuthProperties properties) {
        this.store = store;
        this.properties = properties;
    }

    public SendSmsCodeResponse send(String phone, String clientIp) {
        if (!PHONE.matcher(phone).matches()) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "手机号格式不正确");
        }

        long phoneCount = store.incrementDailyCount("phone", phone, DAILY_WINDOW);
        if (phoneCount > properties.getSmsDailyLimitPerPhone()) {
            throw BizException.of(ErrorCode.SMS_SEND_TOO_FREQUENT, "该手机号今日验证码发送次数已达上限");
        }
        if (clientIp != null && !clientIp.isBlank()) {
            long ipCount = store.incrementDailyCount("ip", clientIp, DAILY_WINDOW);
            if (ipCount > properties.getSmsDailyLimitPerIp()) {
                throw BizException.of(ErrorCode.SMS_SEND_TOO_FREQUENT, "当前网络今日验证码发送次数已达上限");
            }
        }

        if (!store.tryAcquireSendLock(phone, properties.getSmsSendInterval())) {
            throw BizException.of(ErrorCode.SMS_SEND_TOO_FREQUENT);
        }

        String code = String.format("%06d", random.nextInt(1_000_000));
        store.saveCode(phone, code, properties.getSmsCodeTtl());
        store.clearVerifyFailure(phone);

        // TODO 接入真实短信通道（spec §11 阶段一第 6 步），当前仅记录脱敏日志
        log.info("已生成短信验证码 phone={}", maskPhone(phone));

        return new SendSmsCodeResponse(
                properties.getSmsCodeTtl().toSeconds(),
                properties.isExposeSmsCode() ? code : null);
    }

    /**
     * 校验验证码。校验成功后立即失效，避免重放。
     */
    public void verify(String phone, String code) {
        String expected = store.findCode(phone)
                .orElseThrow(() -> BizException.of(ErrorCode.SMS_CODE_INVALID));
        if (!expected.equals(code)) {
            long failures = store.incrementVerifyFailure(phone, properties.getSmsCodeTtl());
            if (failures >= properties.getSmsMaxVerifyAttempts()) {
                store.deleteCode(phone);
                store.clearVerifyFailure(phone);
            }
            throw BizException.of(ErrorCode.SMS_CODE_INVALID);
        }
        store.deleteCode(phone);
        store.clearVerifyFailure(phone);
    }

    private String maskPhone(String phone) {
        return phone.length() >= 11
                ? phone.substring(0, 3) + "****" + phone.substring(7)
                : "***";
    }
}
