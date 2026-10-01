package com.chronoflow.personal.geo;

import java.math.BigDecimal;

/**
 * 一个可被选中的地点（POI）。
 *
 * <p>坐标一律是 **GCJ-02**：国内地图服务（高德 / 腾讯）的展示层坐标系，
 * 落库时不做二次转换（spec §5.9）。
 *
 * @param provider 产出该结果的服务商，便于前端区分降级态
 */
public record GeoPlace(String poiId,
                       String name,
                       String address,
                       BigDecimal latitude,
                       BigDecimal longitude,
                       String city,
                       String district,
                       String provider) {
}
