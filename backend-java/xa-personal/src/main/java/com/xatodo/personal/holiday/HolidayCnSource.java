package com.xatodo.personal.holiday;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * holiday-cn（https://github.com/NateScarlet/holiday-cn）数据源。
 *
 * <p>它把国务院办公厅每年的放假通知整理成 JSON：`days[].isOffDay` 为 true 是放假、
 * false 是调休上班，`papers` 保留通知原文链接。地址可用配置覆盖，便于指向内网镜像。
 */
@Component
public class HolidayCnSource implements HolidaySource {

    private static final Logger log = LoggerFactory.getLogger(HolidayCnSource.class);

    private final String baseUrl;
    private final Duration timeout;
    private final HttpClient client;

    public HolidayCnSource(@Value("${xatodo.holiday.sync.base-url:https://raw.githubusercontent.com/NateScarlet/holiday-cn/master}")
                           String baseUrl,
                           @Value("${xatodo.holiday.sync.timeout:15s}") Duration timeout) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.timeout = timeout;
        this.client = HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    @Override
    public String fetch(int year) throws IOException, InterruptedException {
        URI uri = URI.create(baseUrl + "/" + year + ".json");
        HttpRequest request = HttpRequest.newBuilder(uri).timeout(timeout).GET().build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 404) {
            // 次年文件在通知发布前就是 404：这是「还没发布」，不是故障
            log.info("holiday-cn 还没有 {} 年的数据（尚未发布），本次跳过", year);
            return null;
        }
        if (response.statusCode() != 200) {
            throw new IOException("holiday-cn 返回 HTTP " + response.statusCode() + ": " + uri);
        }
        return response.body();
    }
}
