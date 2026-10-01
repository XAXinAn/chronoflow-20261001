package com.chronoflow.admin.web;

import com.chronoflow.admin.dto.AdminDtos.AuditLogResponse;
import com.chronoflow.admin.dto.AdminDtos.DashboardResponse;
import com.chronoflow.admin.dto.AdminDtos.SystemConfigResponse;
import com.chronoflow.admin.dto.AdminDtos.SystemConfigUpdateRequest;
import com.chronoflow.admin.entity.AuditLog;
import com.chronoflow.admin.security.CurrentAdmin;
import com.chronoflow.admin.service.AdminConfigService;
import com.chronoflow.admin.service.AuditLogService;
import com.chronoflow.admin.service.DashboardService;
import com.chronoflow.common.api.ApiResponse;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 全局配置、数据看板与审计日志（spec §4.4）。仅平台超管可访问。
 */
@RestController
@RequestMapping("/api/v1/admin")
@SecurityRequirement(name = "bearerAuth")
public class AdminOpsController {

    private final AdminConfigService configService;
    private final DashboardService dashboardService;
    private final AuditLogService auditLogService;

    public AdminOpsController(AdminConfigService configService,
                              DashboardService dashboardService,
                              AuditLogService auditLogService) {
        this.configService = configService;
        this.dashboardService = dashboardService;
        this.auditLogService = auditLogService;
    }

    @GetMapping("/configs")
    public ApiResponse<List<SystemConfigResponse>> configs() {
        CurrentAdmin.requireSuperAdmin();
        return ApiResponse.ok(configService.list());
    }

    @PutMapping("/configs/{key}")
    public ApiResponse<SystemConfigResponse> updateConfig(@PathVariable String key,
                                                          @Valid @RequestBody SystemConfigUpdateRequest request) {
        return ApiResponse.ok(configService.update(CurrentAdmin.requireSuperAdmin(), key, request));
    }

    @GetMapping("/dashboard/stats")
    public ApiResponse<DashboardResponse> stats() {
        CurrentAdmin.requireSuperAdmin();
        return ApiResponse.ok(dashboardService.stats());
    }

    @GetMapping("/audit-logs")
    public ApiResponse<List<AuditLogResponse>> auditLogs(
            @RequestParam(required = false) String action,
            @RequestParam(required = false) String actorName,
            @RequestParam(required = false) Long orgId,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime from,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime to,
            @RequestParam(defaultValue = "100") int limit) {
        CurrentAdmin.requireSuperAdmin();
        return ApiResponse.ok(auditLogService.search(action, actorName, orgId, from, to, limit).stream()
                .map(this::toResponse).toList());
    }

    @GetMapping(value = "/audit-logs/export", produces = "text/csv;charset=UTF-8")
    public ResponseEntity<String> exportAuditLogs(
            @RequestParam(required = false) String action,
            @RequestParam(required = false) String actorName,
            @RequestParam(required = false) Long orgId,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime from,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime to,
            @RequestParam(defaultValue = "500") int limit) {
        CurrentAdmin.requireSuperAdmin();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"audit-logs.csv\"")
                .contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
                .body(auditLogService.exportCsv(action, actorName, orgId, from, to, limit));
    }

    private AuditLogResponse toResponse(AuditLog entry) {
        return new AuditLogResponse(entry.getId(), entry.getActorType(), entry.getActorName(),
                entry.getOrgId(), entry.getAction(), entry.getTargetType(), entry.getTargetId(),
                entry.getDetail(), entry.getIp(), entry.getCreatedAt());
    }
}
