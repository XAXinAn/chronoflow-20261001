package com.chronoflow.admin.web;

import com.chronoflow.admin.dto.AdminDtos.AuditLogResponse;
import com.chronoflow.admin.entity.AuditLog;
import com.chronoflow.admin.security.AdminPrincipal;
import com.chronoflow.admin.service.AuditLogService;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 组织管理端里需要审计表的那部分接口（spec §6.3 `GET /org-admin/logs`）。
 *
 * <p>放在 {@code chronoflow-admin} 是因为 {@code audit_log} 的实体与 mapper 在这里，而 {@code chronoflow-org}
 * 不能反向依赖本模块。路径仍属 {@code /org-admin/**}，由后台过滤器解析令牌。
 *
 * <p>只服务**后台组织管理员**：操作日志是组织管理端的页面，App 的组织身份不读它。
 */
@RestController
@RequestMapping("/api/v1/org-admin")
@SecurityRequirement(name = "bearerAuth")
public class OrgConsoleController {

    private final AuditLogService auditLogService;

    public OrgConsoleController(AuditLogService auditLogService) {
        this.auditLogService = auditLogService;
    }

    @GetMapping("/logs")
    public ApiResponse<List<AuditLogResponse>> logs(
            @RequestParam(required = false) String action,
            @RequestParam(defaultValue = "100") int limit) {
        AdminPrincipal admin = requireOrgAdmin();
        return ApiResponse.ok(auditLogService.search(action, null, admin.orgId(), null, null, limit)
                .stream().map(this::toResponse).toList());
    }

    private AdminPrincipal requireOrgAdmin() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        Object principal = authentication == null ? null : authentication.getPrincipal();
        if (principal instanceof AdminPrincipal admin) {
            if (admin.orgId() == null) {
                throw BizException.of(ErrorCode.FORBIDDEN, "该接口需要组织管理员身份");
            }
            return admin;
        }
        throw BizException.of(ErrorCode.FORBIDDEN, "该接口只服务后台组织管理员");
    }

    private AuditLogResponse toResponse(AuditLog entry) {
        return new AuditLogResponse(entry.getId(), entry.getActorType(), entry.getActorName(),
                entry.getOrgId(), entry.getAction(), entry.getTargetType(), entry.getTargetId(),
                entry.getDetail(), entry.getIp(), entry.getCreatedAt());
    }
}
