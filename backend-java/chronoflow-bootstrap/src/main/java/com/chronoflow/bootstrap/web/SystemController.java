package com.chronoflow.bootstrap.web;

import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.common.web.TraceIds;
import com.chronoflow.agent.service.AgentChatService;
import com.chronoflow.bootstrap.config.AppReleaseProperties;
import com.chronoflow.personal.geo.GeoService;
import com.chronoflow.personal.service.HolidaySyncStatus;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;

/**
 * 系统探活与元信息接口，用于联通性验证。
 */
@RestController
@RequestMapping("/api/v1/system")
public class SystemController {

    @Value("${spring.application.name:chronoflow-backend}")
    private String applicationName;

    @Value("${chronoflow.version:0.1.0-SNAPSHOT}")
    private String version;

    private final GeoService geoService;
    private final HolidaySyncStatus holidaySyncStatus;
    private final AgentChatService agentChatService;
    private final AppReleaseProperties appRelease;

    public SystemController(GeoService geoService,
                            HolidaySyncStatus holidaySyncStatus,
                            AgentChatService agentChatService,
                            AppReleaseProperties appRelease) {
        this.geoService = geoService;
        this.holidaySyncStatus = holidaySyncStatus;
        this.agentChatService = agentChatService;
        this.appRelease = appRelease;
    }

    @GetMapping("/info")
    public ApiResponse<SystemInfo> info() {
        return ApiResponse.ok(new SystemInfo(
                applicationName,
                version,
                OffsetDateTime.now(ZoneOffset.UTC).toString(),
                geoService.providerName(),
                geoService.degraded(),
                agentChatService.enabled(),
                HolidaySyncInfo.from(holidaySyncStatus.snapshot())));
    }

    @GetMapping("/ping")
    public ApiResponse<String> ping() {
        return ApiResponse.ok("pong");
    }

    /**
     * App 新版本发布信息（spec §4.1.11「应用内更新」）。**免登录**：版本检查发生在
     * 登录之前也要能用（否则「登录接口改了、老客户端登不上」就永远升不了级）。
     *
     * <p>未配置发布信息时返回 `versionCode = 0`（见 {@link AppReleaseInfo#none()}），
     * App 据此认为「这个部署没有提供应用内更新」，不弹窗。
     */
    @GetMapping("/app-release")
    public ApiResponse<AppReleaseInfo> appRelease() {
        return ApiResponse.ok(AppReleaseInfo.from(appRelease));
    }

    /**
     * @param versionName            展示用版本名（如 0.2.0）
     * @param versionCode            整数版本号，App 拿它和本地 `versionCode` 比大小
     * @param apkUrl                 安装包地址：绝对 URL，或以 `/` 开头的相对路径（App 拼当前 API 域名）
     * @param sizeBytes              安装包字节数（0 = 没配）
     * @param sha256                 安装包 SHA-256（为空 = 不校验）
     * @param changelog              更新说明，逐条
     * @param force                  是否强制更新（App 不给「稍后」）
     * @param minSupportedVersionCode 低于这个版本号的客户端必须更新（0 = 不限制）
     * @param publishedAt            发布时间，ISO-8601；没配就是 null
     */
    public record AppReleaseInfo(String versionName, int versionCode, String apkUrl, long sizeBytes,
                                 String sha256, List<String> changelog, boolean force,
                                 int minSupportedVersionCode, String publishedAt) {

        /** 这个部署没有提供应用内更新：只回一个 0 版本号，其余留空。 */
        private static AppReleaseInfo none() {
            return new AppReleaseInfo(null, 0, null, 0, null, List.of(), false, 0, null);
        }

        public static AppReleaseInfo from(AppReleaseProperties properties) {
            if (!properties.configured()) {
                return none();
            }
            return new AppReleaseInfo(
                    properties.displayVersionName(),
                    properties.getVersionCode(),
                    properties.getApkUrl(),
                    properties.getSizeBytes(),
                    properties.getSha256(),
                    properties.changelogItems(),
                    properties.isForce(),
                    properties.getMinSupportedVersionCode(),
                    properties.getPublishedAt());
        }
    }

    /**
     * @param geoProvider     当前生效的地点服务商（amap / local）
     * @param geoDegraded     是否处于降级态；App 据此提示「当前是内置地点集」而不是当成网络故障
     * @param aiAgentEnabled  小安（智能助手）是否已接入模型（spec §11 阶段三）。
     *                        App 读到缺失或 false 就保持「还没有接入模型」的提示，
     *                        而不是让用户对着输入框发消息、等一个永远不来的回答。
     * @param holidaySync     节假日数据自动同步的运行状态（spec §5.11）
     */
    public record SystemInfo(String name, String version, String serverTime,
                             String geoProvider, boolean geoDegraded,
                             boolean aiAgentEnabled, HolidaySyncInfo holidaySync) {
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
