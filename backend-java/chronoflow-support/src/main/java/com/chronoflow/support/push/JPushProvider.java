package com.chronoflow.support.push;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极光推送（JPush REST API v3）实现（spec §4.5）。
 *
 * <p>只发**通知**、不依赖极光的 App 内消息通道：组织日程下发/变更这类服务端事件，
 * 用户没打开 App 也要能看到系统通知。
 *
 * <p>几个容易踩的点写在这里：
 * <ul>
 *   <li>认证是 HTTP Basic：用户名 = AppKey、密码 = Master Secret（不是把 AppKey 放 header 里）；</li>
 *   <li>极光**失败也可能返回 200**，响应体里带 `error` 字段，所以不能只看状态码；</li>
 *   <li>单次 audience 上限 1000 个 registrationId，这里按 batchSize 分批；</li>
 *   <li>iOS 是否走生产 APNs 由 `apns_production` 决定，联调期必须为 false。</li>
 * </ul>
 */
@Component
public class JPushProvider implements PushProvider {

    private static final Logger log = LoggerFactory.getLogger(JPushProvider.class);

    private final PushProperties properties;
    private final RestClient client;

    public JPushProvider(PushProperties properties, RestClient.Builder builder) {
        this.properties = properties;
        this.client = builder.baseUrl(properties.getBaseUrl()).build();
    }

    @Override
    public String name() {
        return "jpush";
    }

    @Override
    public boolean configured() {
        return properties.configured();
    }

    @Override
    public PushOutcome send(List<String> registrationIds, PushNotification notification) {
        List<String> targets = registrationIds.stream().filter(id -> id != null && !id.isBlank()).toList();
        if (targets.isEmpty()) {
            return PushOutcome.skipped();
        }
        if (!configured()) {
            // 没配通道不是错误：开发/演示环境就是这样，如实记一笔即可
            log.debug("未配置极光推送通道，跳过 {} 台设备的通知", targets.size());
            return PushOutcome.failed(targets.size(), "push channel not configured");
        }

        List<String> invalid = new ArrayList<>();
        for (int from = 0; from < targets.size(); from += properties.getBatchSize()) {
            List<String> batch = targets.subList(from, Math.min(from + properties.getBatchSize(), targets.size()));
            String failure = sendBatch(batch, notification, invalid);
            if (failure != null) {
                // 一批失败就停：继续发只会把同一个错误重复 N 次，日志也更难读
                return new PushOutcome(targets.size(), invalid, failure);
            }
        }
        return new PushOutcome(targets.size(), invalid, null);
    }

    /** @return null 表示这一批成功 */
    private String sendBatch(List<String> batch, PushNotification notification, List<String> invalidOut) {
        try {
            JsonNode response = client.post()
                    .uri("/v3/push")
                    .header("Authorization", basicAuth())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload(batch, notification))
                    .retrieve()
                    .body(JsonNode.class);
            if (response != null && response.has("error")) {
                // 极光的业务错误：200 + {"error":{"code":..,"message":..}}
                JsonNode error = response.path("error");
                // 1003/1011 等都表示部分 registrationId 无效，能拿到就顺手停用
                if (error.path("code").asInt(-1) == 1011) {
                    invalidOut.addAll(batch);
                }
                return "jpush error " + error.path("code").asInt() + ": " + error.path("message").asText();
            }
            return null;
        } catch (RestClientResponseException ex) {
            return "jpush http " + ex.getStatusCode().value() + ": " + ex.getResponseBodyAsString();
        } catch (RuntimeException ex) {
            // 网络不可达等：推送不能拖垮业务，只记原因
            log.warn("极光推送请求失败：{}", ex.toString());
            return ex.getClass().getSimpleName() + ": " + ex.getMessage();
        }
    }

    private String basicAuth() {
        String raw = properties.getAppKey() + ":" + properties.getMasterSecret();
        return "Basic " + Base64.getEncoder().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    private Map<String, Object> payload(List<String> batch, PushNotification notification) {
        Map<String, Object> android = new LinkedHashMap<>();
        android.put("alert", notification.body());
        android.put("title", notification.title());
        if (notification.extras() != null && !notification.extras().isEmpty()) {
            android.put("extras", notification.extras());
        }

        Map<String, Object> ios = new LinkedHashMap<>();
        ios.put("alert", notification.body());
        ios.put("sound", "default");
        if (notification.extras() != null && !notification.extras().isEmpty()) {
            ios.put("extras", notification.extras());
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("platform", "all");
        payload.put("audience", Map.of("registration_id", batch));
        payload.put("notification", Map.of("android", android, "ios", ios));
        payload.put("options", Map.of(
                "apns_production", properties.isApnsProduction(),
                "time_to_live", properties.getTimeToLiveSeconds()));
        return payload;
    }
}
