package com.xatodo.auth.service;

import com.xatodo.auth.config.AuthProperties;
import com.xatodo.auth.dto.AuthDtos;
import com.xatodo.auth.dto.AuthDtos.SendSmsCodeResponse;
import com.xatodo.auth.sms.SmsSender;
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
 * <p>发送通道由 {@link SmsSender} 决定：开发环境是「不真发 + 响应回显」（{@code expose-sms-code=true}），
 * 部署环境接阿里云短信（{@code xatodo.auth.sms.provider=aliyun}）。
 */
@Service
public class VerificationCodeService {

    private static final Logger log = LoggerFactory.getLogger(VerificationCodeService.class);
    private static final Pattern PHONE = Pattern.compile(AuthDtos.PHONE_PATTERN);
    private static final Duration DAILY_WINDOW = Duration.ofDays(1);

    private final VerificationCodeStore store;
    private final AuthProperties properties;
    private final SmsSender smsSender;
    private final SecureRandom random = new SecureRandom();

    public VerificationCodeService(VerificationCodeStore store,
                                   AuthProperties properties,
                                   SmsSender smsSender) {
        this.store = store;
        this.properties = properties;
        this.smsSender = smsSender;
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

        try {
            smsSender.sendVerificationCode(phone, code);
        } catch (RuntimeException ex) {
            // 没发出去就别把用户锁在 60 秒频控里：清掉验证码与发送锁，让他立刻重试
            store.deleteCode(phone);
            store.releaseSendLock(phone);
            log.warn("验证码短信发送失败 phone={} reason={}", maskPhone(phone), ex.getMessage());
            throw ex;
        }
        log.info("已发送短信验证码 phone={}", maskPhone(phone));

        return new SendSmsCodeResponse(
                properties.getSmsCodeTtl().toSeconds(),
                exposeCode() ? code : null);
    }

    /**
     * 是否在响应里回显验证码。
     *
     * <p>接了真实短信通道就**永不回显**——哪怕有人误把 {@code expose-sms-code} 打开，
     * 也不能让接口把验证码直接吐出来（那是把账号拱手送人）。
     */
    private boolean exposeCode() {
        return properties.isExposeSmsCode() && !"aliyun".equals(properties.getSms().getProvider());
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
