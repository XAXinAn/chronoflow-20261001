package com.xatodo.auth.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * 认证相关配置，见 spec §3.5、§3.6。
 */
@Component
@ConfigurationProperties(prefix = "xatodo.auth")
public class AuthProperties {

    /** JWT 签名密钥，长度必须 >= 32 字节；生产环境通过环境变量注入。 */
    private String jwtSecret = "xa-todo-development-secret-key-change-me-in-production";

    private String issuer = "xa-todo";

    private Duration accessTokenTtl = Duration.ofHours(2);

    private Duration refreshTokenTtl = Duration.ofDays(90);

    /**
     * 刷新令牌轮换宽限期。旧令牌被轮换后仍在其内可复用（返回同一个新令牌），
     * 用于消除 App 并发刷新导致的「被登出」体验（spec §3.7）。
     */
    private Duration refreshRotationGrace = Duration.ofSeconds(60);

    private Duration registerTokenTtl = Duration.ofMinutes(30);

    private Duration selectTokenTtl = Duration.ofMinutes(30);

    private Duration smsCodeTtl = Duration.ofMinutes(5);

    private Duration smsSendInterval = Duration.ofSeconds(60);

    private int smsDailyLimitPerPhone = 10;

    private int smsDailyLimitPerIp = 30;

    private int smsMaxVerifyAttempts = 5;

    private int maxDevicesPerIdentity = 5;

    /**
     * 开发/测试环境专用：为 true 时发送验证码接口会在响应中回显验证码。
     * 生产环境必须为 false（无短信通道时无法登录）。
     */
    private boolean exposeSmsCode = false;

    /** 真实短信通道配置（spec §3.6 / §11 阶段一第 6 步）。 */
    private Sms sms = new Sms();

    public String getJwtSecret() {
        return jwtSecret;
    }

    public void setJwtSecret(String jwtSecret) {
        this.jwtSecret = jwtSecret;
    }

    public String getIssuer() {
        return issuer;
    }

    public void setIssuer(String issuer) {
        this.issuer = issuer;
    }

    public Duration getAccessTokenTtl() {
        return accessTokenTtl;
    }

    public void setAccessTokenTtl(Duration accessTokenTtl) {
        this.accessTokenTtl = accessTokenTtl;
    }

    public Duration getRefreshTokenTtl() {
        return refreshTokenTtl;
    }

    public void setRefreshTokenTtl(Duration refreshTokenTtl) {
        this.refreshTokenTtl = refreshTokenTtl;
    }

    public Duration getRefreshRotationGrace() {
        return refreshRotationGrace;
    }

    public void setRefreshRotationGrace(Duration refreshRotationGrace) {
        this.refreshRotationGrace = refreshRotationGrace;
    }

    public Duration getRegisterTokenTtl() {
        return registerTokenTtl;
    }

    public void setRegisterTokenTtl(Duration registerTokenTtl) {
        this.registerTokenTtl = registerTokenTtl;
    }

    public Duration getSelectTokenTtl() {
        return selectTokenTtl;
    }

    public void setSelectTokenTtl(Duration selectTokenTtl) {
        this.selectTokenTtl = selectTokenTtl;
    }

    public Duration getSmsCodeTtl() {
        return smsCodeTtl;
    }

    public void setSmsCodeTtl(Duration smsCodeTtl) {
        this.smsCodeTtl = smsCodeTtl;
    }

    public Duration getSmsSendInterval() {
        return smsSendInterval;
    }

    public void setSmsSendInterval(Duration smsSendInterval) {
        this.smsSendInterval = smsSendInterval;
    }

    public int getSmsDailyLimitPerPhone() {
        return smsDailyLimitPerPhone;
    }

    public void setSmsDailyLimitPerPhone(int smsDailyLimitPerPhone) {
        this.smsDailyLimitPerPhone = smsDailyLimitPerPhone;
    }

    public int getSmsDailyLimitPerIp() {
        return smsDailyLimitPerIp;
    }

    public void setSmsDailyLimitPerIp(int smsDailyLimitPerIp) {
        this.smsDailyLimitPerIp = smsDailyLimitPerIp;
    }

    public int getSmsMaxVerifyAttempts() {
        return smsMaxVerifyAttempts;
    }

    public void setSmsMaxVerifyAttempts(int smsMaxVerifyAttempts) {
        this.smsMaxVerifyAttempts = smsMaxVerifyAttempts;
    }

    public int getMaxDevicesPerIdentity() {
        return maxDevicesPerIdentity;
    }

    public void setMaxDevicesPerIdentity(int maxDevicesPerIdentity) {
        this.maxDevicesPerIdentity = maxDevicesPerIdentity;
    }

    public boolean isExposeSmsCode() {
        return exposeSmsCode;
    }

    public void setExposeSmsCode(boolean exposeSmsCode) {
        this.exposeSmsCode = exposeSmsCode;
    }

    public Sms getSms() {
        return sms;
    }

    public void setSms(Sms sms) {
        this.sms = sms;
    }

    /**
     * 真实短信通道（spec §3.6）。{@code provider} 取 {@code log}（默认，不真发）或 {@code aliyun}。
     *
     * <p>凭据只从环境变量注入，不写进仓库（见 AGENTS §4.5 的密钥约定）。
     */
    public static class Sms {

        private String provider = "log";
        private String accessKeyId;
        private String accessKeySecret;
        private String signName;
        private String templateCode;
        private String regionId = "cn-hangzhou";
        private String endpoint = "dysmsapi.aliyuncs.com";

        public String getProvider() {
            return provider;
        }

        public void setProvider(String provider) {
            this.provider = provider;
        }

        public String getAccessKeyId() {
            return accessKeyId;
        }

        public void setAccessKeyId(String accessKeyId) {
            this.accessKeyId = accessKeyId;
        }

        public String getAccessKeySecret() {
            return accessKeySecret;
        }

        public void setAccessKeySecret(String accessKeySecret) {
            this.accessKeySecret = accessKeySecret;
        }

        public String getSignName() {
            return signName;
        }

        public void setSignName(String signName) {
            this.signName = signName;
        }

        public String getTemplateCode() {
            return templateCode;
        }

        public void setTemplateCode(String templateCode) {
            this.templateCode = templateCode;
        }

        public String getRegionId() {
            return regionId;
        }

        public void setRegionId(String regionId) {
            this.regionId = regionId;
        }

        public String getEndpoint() {
            return endpoint;
        }

        public void setEndpoint(String endpoint) {
            this.endpoint = endpoint;
        }
    }
}
