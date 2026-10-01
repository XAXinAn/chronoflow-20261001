package com.chronoflow.personal.web;

import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.personal.geo.GeoPlace;
import com.chronoflow.personal.geo.GeoService;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.util.List;

/**
 * 地点与地图接口，对应 spec §6.2 的「地点与地图」分组。
 *
 * <p>App 不持有任何地图厂商的 Key，全部经由这里转发。
 */
@RestController
@RequestMapping("/api/v1/geo")
@SecurityRequirement(name = "bearerAuth")
public class GeoController {

    private final GeoService geoService;

    public GeoController(GeoService geoService) {
        this.geoService = geoService;
    }

    /** 关键字搜索地点。 */
    @GetMapping("/places")
    public ApiResponse<List<GeoPlace>> places(@RequestParam String keyword,
                                              @RequestParam(required = false) String city,
                                              @RequestParam(required = false) BigDecimal lat,
                                              @RequestParam(required = false) BigDecimal lng,
                                              @RequestParam(required = false) Integer limit) {
        return ApiResponse.ok(geoService.searchPlaces(keyword, city, lat, lng, limit));
    }

    /** 逆地理编码：定位后回填当前地点。 */
    @GetMapping("/regeo")
    public ApiResponse<GeoPlace> regeo(@RequestParam BigDecimal lat, @RequestParam BigDecimal lng) {
        return ApiResponse.ok(geoService.reverseGeocode(lat, lng));
    }

    /**
     * 服务商状态。App 据此决定是否展示搜索框、以及是否提示「当前是内置地点集」。
     */
    @GetMapping("/config")
    public ApiResponse<GeoStatus> config() {
        return ApiResponse.ok(new GeoStatus(
                geoService.providerName(),
                geoService.configuredProvider(),
                geoService.degraded(),
                geoService.degradedReason(),
                // 只在服务端配了 JS Key 时下发；App 据此决定是否展示「地图选点」
                geoService.jsKey(),
                geoService.jsSecurityCode()));
    }

    /**
     * @param jsApiKey        高德 Web端(JS API) Key，可空；为 null 时客户端不显示地图选点
     * @param jsSecurityCode  配套安全密钥，可空
     */
    public record GeoStatus(String provider,
                            String configuredProvider,
                            boolean degraded,
                            String degradedReason,
                            String jsApiKey,
                            String jsSecurityCode) {
    }
}
