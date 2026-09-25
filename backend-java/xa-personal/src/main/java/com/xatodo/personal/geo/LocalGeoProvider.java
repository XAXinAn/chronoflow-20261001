package com.xatodo.personal.geo;

import org.springframework.util.StringUtils;

import java.math.BigDecimal;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * 内置地点集：没有地图 Key（或外网不可用）时的降级实现。
 *
 * <p>规模刻意保持很小——它的价值不是"够用"，而是让**整条链路在离线环境仍然可验证**：
 * 搜索能返回结果、选中后能落库带坐标、逆地理能回填地点名。
 * 一旦配上真实 Key，{@link GeoService} 就会切到高德，这里不再参与。
 */
public class LocalGeoProvider implements GeoProvider {

    public static final String NAME = "local";

    private static final List<GeoPlace> PLACES = List.of(
            place("BJ-TAM", "天安门广场", "北京市东城区东长安街", "39.908700", "116.397500", "北京市", "东城区"),
            place("BJ-NAN", "北京南站", "北京市丰台区永外大街车站路12号", "39.865400", "116.378700", "北京市", "丰台区"),
            place("BJ-T3", "首都机场T3航站楼", "北京市顺义区机场东路", "40.055300", "116.615100", "北京市", "顺义区"),
            place("BJ-ZGC", "中关村软件园", "北京市海淀区东北旺西路8号", "40.046000", "116.287000", "北京市", "海淀区"),
            place("BJ-GM", "国贸三期", "北京市朝阳区建国门外大街1号", "39.908800", "116.457000", "北京市", "朝阳区"),
            place("BJ-WJ", "望京SOHO", "北京市朝阳区望京街10号", "39.996000", "116.481000", "北京市", "朝阳区"),
            place("SH-BUND", "外滩", "上海市黄浦区中山东一路", "31.240000", "121.490000", "上海市", "黄浦区"),
            place("SH-HQ", "上海虹桥站", "上海市闵行区申贵路1500号", "31.195000", "121.320000", "上海市", "闵行区"),
            place("SH-LJZ", "陆家嘴", "上海市浦东新区陆家嘴环路", "31.240000", "121.505000", "上海市", "浦东新区"),
            place("SH-ZJ", "张江高科", "上海市浦东新区春晓路289号", "31.205000", "121.590000", "上海市", "浦东新区"),
            place("SZ-NORTH", "深圳北站", "深圳市龙华区民治街道", "22.610000", "114.029000", "深圳市", "龙华区"),
            place("SZ-TX", "腾讯滨海大厦", "深圳市南山区科技园南区", "22.523000", "113.935000", "深圳市", "南山区"),
            place("SZ-BAY", "深圳湾科技生态园", "深圳市南山区白石路3609号", "22.529000", "113.948000", "深圳市", "南山区"),
            place("HZ-XH", "西湖", "杭州市西湖区龙井路1号", "30.245000", "120.140000", "杭州市", "西湖区"),
            place("HZ-ALI", "阿里巴巴西溪园区", "杭州市余杭区文一西路969号", "30.279000", "120.026000", "杭州市", "余杭区"),
            place("GZ-TOWER", "广州塔", "广州市海珠区阅江西路222号", "23.106000", "113.325000", "广州市", "海珠区"),
            place("GZ-SOUTH", "广州南站", "广州市番禺区石壁街道", "22.989000", "113.269000", "广州市", "番禺区"));

    private static GeoPlace place(String poiId, String name, String address,
                                  String lat, String lng, String city, String district) {
        return new GeoPlace(poiId, name, address, new BigDecimal(lat), new BigDecimal(lng),
                city, district, NAME);
    }

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public List<GeoPlace> searchPlaces(String keyword, String city, BigDecimal lat, BigDecimal lng, int limit) {
        if (!StringUtils.hasText(keyword)) {
            return List.of();
        }
        String needle = keyword.trim().toLowerCase(Locale.ROOT);
        List<GeoPlace> matched = PLACES.stream()
                .filter(item -> matches(item, needle, city))
                .sorted(distanceComparator(lat, lng))
                .limit(Math.max(1, limit))
                .toList();
        return matched;
    }

    private static boolean matches(GeoPlace item, String needle, String city) {
        boolean hit = item.name().toLowerCase(Locale.ROOT).contains(needle)
                || item.address().toLowerCase(Locale.ROOT).contains(needle);
        if (!hit) {
            return false;
        }
        if (!StringUtils.hasText(city)) {
            return true;
        }
        return item.city() != null && item.city().contains(city.trim());
    }

    /** 给了当前位置就按距离排序，否则按名称稳定排序。 */
    private static Comparator<GeoPlace> distanceComparator(BigDecimal lat, BigDecimal lng) {
        if (lat == null || lng == null) {
            return Comparator.comparing(GeoPlace::name);
        }
        return Comparator.comparingDouble(place -> squaredDistance(lat, lng, place));
    }

    private static double squaredDistance(BigDecimal lat, BigDecimal lng, GeoPlace place) {
        double dLat = lat.doubleValue() - place.latitude().doubleValue();
        double dLng = (lng.doubleValue() - place.longitude().doubleValue()) * 0.78; // 粗略的经纬度比例
        return dLat * dLat + dLng * dLng;
    }

    @Override
    public GeoPlace reverseGeocode(BigDecimal lat, BigDecimal lng) {
        return PLACES.stream()
                .min(Comparator.comparingDouble(place -> squaredDistance(lat, lng, place)))
                // 内置集合覆盖有限，附近没有已知地点时如实告知，不假装知道这是哪儿
                .filter(place -> squaredDistance(lat, lng, place) < 0.25)
                .orElseGet(() -> new GeoPlace(null, "自定义地点", null, lat, lng, null, null, NAME));
    }
}
