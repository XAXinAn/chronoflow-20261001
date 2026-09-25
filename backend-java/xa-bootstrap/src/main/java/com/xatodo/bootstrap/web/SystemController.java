package com.xatodo.bootstrap.web;

import com.xatodo.common.api.ApiResponse;
import com.xatodo.common.web.TraceIds;
import com.xatodo.personal.geo.GeoService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;

/**
 * 系统探活与元信息接口，用于联通性验证。
 */
@RestController
@RequestMapping("/api/v1/system")
public class SystemController {

    @Value("${spring.application.name:xa-todo-backend}")
    private String applicationName;

    @Value("${xatodo.version:0.1.0-SNAPSHOT}")
    private String version;

    private final GeoService geoService;

    public SystemController(GeoService geoService) {
        this.geoService = geoService;
    }

    @GetMapping("/info")
    public ApiResponse<SystemInfo> info() {
        return ApiResponse.ok(new SystemInfo(
                applicationName,
                version,
                OffsetDateTime.now(ZoneOffset.UTC).toString(),
                geoService.providerName(),
                geoService.degraded()));
    }

    @GetMapping("/ping")
    public ApiResponse<String> ping() {
        return ApiResponse.ok("pong");
    }

    /**
     * @param geoProvider 当前生效的地点服务商（amap / local）
     * @param geoDegraded 是否处于降级态；App 据此提示「当前是内置地点集」而不是当成网络故障
     */
    public record SystemInfo(String name, String version, String serverTime,
                             String geoProvider, boolean geoDegraded) {
    }
}
