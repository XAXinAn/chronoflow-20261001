package com.xatodo.support.push;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 推送通道配置（spec §4.5）。
 *
 * <p>AppKey 是公开的（会编进 APK）；**Master Secret 只用于服务端调极光 REST API**，
 * 只能来自环境变量，绝不进仓库、也绝不下发给客户端。
 *
 * <p>两者都为空时不是错误：{@link PushProvider} 会降级成「未配置」，
 * 推送相关的接口如实上报状态，其余功能不受影响（与地点服务降级同一套做法）。
 */
@Component
@ConfigurationProperties(prefix = "xatodo.push")
public class PushProperties {

    /** 极光 AppKey；为空表示没配推送通道。 */
    private String appKey = "";

    /** 极光 Master Secret；只给服务端。 */
    private String masterSecret = "";

    /** 极光 REST 地址，便于测试与灰度切换。 */
    private String baseUrl = "https://api.jpush.cn";

    /** iOS 是否走生产环境 APNs；开发/联调期置 false 才能收到。 */
    private boolean apnsProduction = true;

    /** 通知保留时长（秒）。 */
    private long timeToLiveSeconds = 86400;

    /** 单次请求最多带多少个 registrationId（极光上限 1000，这里留余量）。 */
    private int batchSize = 500;

    public boolean configured() {
        return !appKey.isBlank() && !masterSecret.isBlank();
    }

    public String getAppKey() {
        return appKey;
    }

    public void setAppKey(String appKey) {
        this.appKey = appKey == null ? "" : appKey.trim();
    }

    public String getMasterSecret() {
        return masterSecret;
    }

    public void setMasterSecret(String masterSecret) {
        this.masterSecret = masterSecret == null ? "" : masterSecret.trim();
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public boolean isApnsProduction() {
        return apnsProduction;
    }

    public void setApnsProduction(boolean apnsProduction) {
        this.apnsProduction = apnsProduction;
    }

    public long getTimeToLiveSeconds() {
        return timeToLiveSeconds;
    }

    public void setTimeToLiveSeconds(long timeToLiveSeconds) {
        this.timeToLiveSeconds = timeToLiveSeconds;
    }

    public int getBatchSize() {
        return batchSize;
    }

    public void setBatchSize(int batchSize) {
        this.batchSize = batchSize;
    }
}
