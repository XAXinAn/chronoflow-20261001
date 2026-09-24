package com.xatodo.bootstrap.web;

import com.xatodo.common.api.ApiResponse;
import com.xatodo.common.web.TraceIds;
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

    @GetMapping("/info")
    public ApiResponse<SystemInfo> info() {
        return ApiResponse.ok(new SystemInfo(
                applicationName,
                version,
                OffsetDateTime.now(ZoneOffset.UTC).toString()));
    }

    @GetMapping("/ping")
    public ApiResponse<String> ping() {
        return ApiResponse.ok("pong");
    }

    public record SystemInfo(String name, String version, String serverTime) {
    }
}
