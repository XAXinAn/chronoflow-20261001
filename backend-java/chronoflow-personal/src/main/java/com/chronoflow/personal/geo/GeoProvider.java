package com.chronoflow.personal.geo;

import java.math.BigDecimal;
import java.util.List;

/**
 * 地理服务抽象（spec §5.9）。
 *
 * <p>之所以要把服务商挡在这一层后面：Key 只能留在服务端，且必须能在
 * 「有 Key 用真实数据 / 没 Key 也能跑通全流程」两种状态下切换，
 * 否则自动化测试和离线开发都得依赖外网。
 */
public interface GeoProvider {

    /** 服务商标识，如 {@code amap} / {@code local}。 */
    String name();

    /**
     * 关键字搜索地点。
     *
     * @param city 限定城市，可为空
     * @param lat  当前位置纬度，可为空（用于按距离排序）
     * @param lng  当前位置经度，可为空
     */
    List<GeoPlace> searchPlaces(String keyword, String city, BigDecimal lat, BigDecimal lng, int limit);

    /** 逆地理编码：坐标 → 最近的地点。 */
    GeoPlace reverseGeocode(BigDecimal lat, BigDecimal lng);
}
