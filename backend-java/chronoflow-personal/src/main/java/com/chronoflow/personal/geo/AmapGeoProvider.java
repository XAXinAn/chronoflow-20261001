package com.chronoflow.personal.geo;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * 高德 Web 服务实现。
 *
 * <p>走的是**服务端直连**：App 只调本服务的 {@code /geo/*}，Key 从不离开服务端，
 * 这样 Key 可轮换、可限流、可按租户统计配额（spec §5.9）。
 *
 * <p>高德返回的坐标本身就是 GCJ-02，与落库口径一致，不需要转换。
 */
public class AmapGeoProvider implements GeoProvider {

    public static final String NAME = "amap";

    private final GeoProperties.Amap config;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public AmapGeoProvider(GeoProperties.Amap config, ObjectMapper objectMapper) {
        this.config = config;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(Math.max(1, config.getTimeoutSeconds())))
                .build();
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
        StringBuilder url = new StringBuilder(config.getBaseUrl())
                .append("/v3/place/text?key=").append(encode(config.getKey()))
                .append("&keywords=").append(encode(keyword))
                .append("&offset=").append(Math.min(Math.max(limit, 1), 25))
                .append("&page=1&extensions=base");
        if (StringUtils.hasText(city)) {
            url.append("&city=").append(encode(city));
        }
        if (lat != null && lng != null) {
            // 高德的 location 参数是「经度,纬度」，与常见写法相反，别写反
            url.append("&location=").append(lng.toPlainString()).append(',').append(lat.toPlainString());
        }

        JsonNode root = get(url.toString());
        List<GeoPlace> places = new ArrayList<>();
        for (JsonNode poi : root.path("pois")) {
            BigDecimal[] coordinate = parseLocation(poi.path("location").asText(null));
            if (coordinate == null) {
                continue;
            }
            places.add(new GeoPlace(
                    textOrNull(poi, "id"),
                    textOrNull(poi, "name"),
                    textOrNull(poi, "address"),
                    coordinate[1],
                    coordinate[0],
                    textOrNull(poi, "cityname"),
                    textOrNull(poi, "adname"),
                    NAME));
        }
        return places;
    }

    @Override
    public GeoPlace reverseGeocode(BigDecimal lat, BigDecimal lng) {
        String url = config.getBaseUrl()
                + "/v3/geocode/regeo?key=" + encode(config.getKey())
                + "&location=" + lng.toPlainString() + "," + lat.toPlainString()
                + "&extensions=base";

        JsonNode root = get(url);
        JsonNode regeocode = root.path("regeocode");
        String address = textOrNull(regeocode, "formatted_address");

        JsonNode component = regeocode.path("addressComponent");
        String city = textOrNull(component, "city");
        if (!StringUtils.hasText(city)) {
            // 高德对直辖市返回空 city，此时用 province 兜底
            city = textOrNull(component, "province");
        }
        String district = textOrNull(component, "district");

        // 逆地理优先给出一个有名字的 POI，否则只回地址
        JsonNode pois = regeocode.path("pois");
        if (pois.isArray() && !pois.isEmpty()) {
            JsonNode poi = pois.get(0);
            return new GeoPlace(textOrNull(poi, "id"), textOrNull(poi, "name"), address, lat, lng,
                    city, district, NAME);
        }
        return new GeoPlace(null, StringUtils.hasText(address) ? address : "当前位置", address, lat, lng,
                city, district, NAME);
    }

    /** 发请求并校验高德的业务状态码（HTTP 200 也可能是失败，例如 Key 无效）。 */
    private JsonNode get(String url) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(Math.max(1, config.getTimeoutSeconds())))
                .header("Accept", "application/json")
                .GET()
                .build();
        String body;
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                        "地点服务返回 HTTP " + response.statusCode());
            }
            body = response.body();
        } catch (IOException cause) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "地点服务不可达");
        } catch (InterruptedException cause) {
            Thread.currentThread().interrupt();
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "地点服务调用被中断");
        }

        JsonNode root;
        try {
            root = objectMapper.readTree(body);
        } catch (IOException cause) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "地点服务返回内容无法解析");
        }
        if (!"1".equals(root.path("status").asText())) {
            // 把 info 带出去：Key 无效 / 配额用尽 / 参数错误 的排查全靠它
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "地点服务调用失败: " + root.path("info").asText("未知原因"));
        }
        return root;
    }

    /** 高德的 "经度,纬度" 字符串 → [经度, 纬度]，非法返回 null。 */
    private static BigDecimal[] parseLocation(String value) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        String[] parts = value.split(",");
        if (parts.length != 2) {
            return null;
        }
        try {
            return new BigDecimal[]{new BigDecimal(parts[0].trim()), new BigDecimal(parts[1].trim())};
        } catch (NumberFormatException cause) {
            return null;
        }
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull() || !StringUtils.hasText(value.asText())) {
            return null;
        }
        return value.asText();
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
