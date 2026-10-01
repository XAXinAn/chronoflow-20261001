package com.chronoflow.personal.geo;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.math.BigDecimal;
import java.util.List;

/**
 * 地点服务入口：把「用哪个服务商」这件事收敛到一处。
 *
 * <p>降级规则：期望高德但没配 Key 时自动落到内置地点集，并把 {@code degraded}
 * 暴露给客户端——降级必须**可见**，否则用户会把「搜不到地方」当成网络故障（spec §5.9）。
 */
@Service
public class GeoService {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 50;

    private final GeoProvider active;
    private final String configuredProvider;
    private final String degradedReason;
    private final String jsKey;
    private final String jsSecurityCode;

    public GeoService(GeoProperties properties, ObjectMapper objectMapper) {
        this.configuredProvider = StringUtils.hasText(properties.getProvider())
                ? properties.getProvider().trim().toLowerCase() : LocalGeoProvider.NAME;
        // 地图选点用的 JS Key 与搜索用的 Web 服务 Key 是两套凭证，独立下发：
        // 只有搜索 Key 时地图选点入口会隐藏，但搜索仍然可用。
        this.jsKey = properties.getAmap().hasJsKey() ? properties.getAmap().getJsKey() : null;
        this.jsSecurityCode = StringUtils.hasText(properties.getAmap().getJsSecurityCode())
                ? properties.getAmap().getJsSecurityCode() : null;

        if (AmapGeoProvider.NAME.equals(configuredProvider) && properties.getAmap().hasKey()) {
            this.active = new AmapGeoProvider(properties.getAmap(), objectMapper);
            this.degradedReason = null;
        } else {
            this.active = new LocalGeoProvider();
            this.degradedReason = AmapGeoProvider.NAME.equals(configuredProvider)
                    ? "未配置高德 Key，已降级为内置地点集"
                    : null;
        }
    }

    public String providerName() {
        return active.name();
    }

    public String configuredProvider() {
        return configuredProvider;
    }

    public boolean degraded() {
        return degradedReason != null;
    }

    public String degradedReason() {
        return degradedReason;
    }

    /** 可空：未配置时 App 隐藏「地图选点」，退回列表搜索。 */
    public String jsKey() {
        return jsKey;
    }

    public String jsSecurityCode() {
        return jsSecurityCode;
    }

    public List<GeoPlace> searchPlaces(String keyword, String city, BigDecimal lat, BigDecimal lng, Integer limit) {
        if (!StringUtils.hasText(keyword)) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "keyword 不能为空");
        }
        requireCoordinateRange(lat, lng);
        int size = limit == null ? DEFAULT_LIMIT : Math.min(Math.max(limit, 1), MAX_LIMIT);
        return active.searchPlaces(keyword.trim(), city, lat, lng, size);
    }

    public GeoPlace reverseGeocode(BigDecimal lat, BigDecimal lng) {
        if (lat == null || lng == null) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "lat 与 lng 不能为空");
        }
        requireCoordinateRange(lat, lng);
        return active.reverseGeocode(lat, lng);
    }

    private static void requireCoordinateRange(BigDecimal lat, BigDecimal lng) {
        if (lat == null || lng == null) {
            return;
        }
        if (lat.compareTo(BigDecimal.valueOf(-90)) < 0 || lat.compareTo(BigDecimal.valueOf(90)) > 0
                || lng.compareTo(BigDecimal.valueOf(-180)) < 0 || lng.compareTo(BigDecimal.valueOf(180)) > 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "经纬度超出有效范围");
        }
    }
}
