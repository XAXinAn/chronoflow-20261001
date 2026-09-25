package com.xatodo.bootstrap.web;

import com.xatodo.common.api.ApiResponse;
import com.xatodo.common.web.TraceIds;
import com.xatodo.personal.geo.GeoService;
import com.xatodo.personal.service.HolidaySyncStatus;
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
    private final HolidaySyncStatus holidaySyncStatus;

    public SystemController(GeoService geoService, HolidaySyncStatus holidaySyncStatus) {
        this.geoService = geoService;
        this.holidaySyncStatus = holidaySyncStatus;
    }

    @GetMapping("/info")
    public ApiResponse<SystemInfo> info() {
        return ApiResponse.ok(new SystemInfo(
                applicationName,
                version,
                OffsetDateTime.now(ZoneOffset.UTC).toString(),
                geoService.providerName(),
                geoService.degraded(),
                HolidaySyncInfo.from(holidaySyncStatus.snapshot())));
    }

    @GetMapping("/ping")
    public ApiResponse<String> ping() {
        return ApiResponse.ok("pong");
    }

    /**
     * @param geoProvider     当前生效的地点服务商（amap / local）
     * @param geoDegraded     是否处于降级态；App 据此提示「当前是内置地点集」而不是当成网络故障
     * @param holidaySync     节假日数据自动同步的运行状态（spec §5.11）
     */
    public record SystemInfo(String name, String version, String serverTime,
                             String geoProvider, boolean geoDegraded,
                             HolidaySyncInfo holidaySync) {
    }

    /**
     * 后台任务最糟的失败方式是静默失败——库里还是去年的放假安排，界面上什么也看不出来。
     * 所以把「最后一次成功是什么时候 / 最近失败原因」如实上报。
     *
     * @param lastSuccessAt 从未成功过就是 null，这本身就是个需要排查的信号
     */
    public record HolidaySyncInfo(String lastRunAt, String lastSuccessAt, String lastError,
                                  int lastSyncedDays, java.util.List<Integer> years) {

        static HolidaySyncInfo from(HolidaySyncStatus.Snapshot snapshot) {
            return new HolidaySyncInfo(
                    snapshot.lastRunAt() == null ? null : snapshot.lastRunAt().toString(),
                    snapshot.lastSuccessAt() == null ? null : snapshot.lastSuccessAt().toString(),
                    snapshot.lastError(),
                    snapshot.lastSyncedDays(),
                    snapshot.years());
        }
    }
}
