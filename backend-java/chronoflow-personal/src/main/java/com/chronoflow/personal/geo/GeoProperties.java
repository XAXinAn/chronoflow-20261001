package com.chronoflow.personal.geo;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * 地图服务配置。
 *
 * <p>未配置 Key 时 {@code GeoService} 会自动降级到内置地点集，
 * 保证没有外网、没有 Key 的环境（CI、离线开发）也能跑通完整流程。
 */
@Component
@ConfigurationProperties(prefix = "chronoflow.geo")
public class GeoProperties {

    /** 期望的服务商：amap / local。缺 Key 时实际生效的仍是 local。 */
    private String provider = "amap";

    private final Amap amap = new Amap();

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public Amap getAmap() {
        return amap;
    }

    public static class Amap {

        private String key = "";

        /**
         * Web端(JS API) Key 与安全密钥。
         *
         * <p>这两个值最终必须出现在客户端（WebView 里加载高德 JS 地图），
         * 属于高德的设计使然，无法像 Web 服务 Key 那样只留服务端。
         * 因此由后端下发，好处是**换 Key 不需要重新发版**；
         * 权限上要靠高德控制台的域名白名单约束，而不是靠藏。
         */
        private String jsKey = "";

        private String jsSecurityCode = "";

        private String baseUrl = "https://restapi.amap.com";

        private int timeoutSeconds = 5;

        public boolean hasKey() {
            return StringUtils.hasText(key);
        }

        public String getKey() {
            return key;
        }

        public void setKey(String key) {
            this.key = key;
        }

        public boolean hasJsKey() {
            return StringUtils.hasText(jsKey);
        }

        public String getJsKey() {
            return jsKey;
        }

        public void setJsKey(String jsKey) {
            this.jsKey = jsKey;
        }

        public String getJsSecurityCode() {
            return jsSecurityCode;
        }

        public void setJsSecurityCode(String jsSecurityCode) {
            this.jsSecurityCode = jsSecurityCode;
        }

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public int getTimeoutSeconds() {
            return timeoutSeconds;
        }

        public void setTimeoutSeconds(int timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
        }
    }
}
