package com.xatodo.admin.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.admin.entity.AuditLog;
import com.xatodo.admin.mapper.AuditLogMapper;
import com.xatodo.admin.security.AdminPrincipal;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 审计日志。仅追加，不提供修改/删除（spec §7.1）。
 */
@Service
public class AuditLogService {

    private static final Logger log = LoggerFactory.getLogger(AuditLogService.class);

    private final AuditLogMapper auditLogMapper;
    private final ObjectMapper objectMapper;

    public AuditLogService(AuditLogMapper auditLogMapper, ObjectMapper objectMapper) {
        this.auditLogMapper = auditLogMapper;
        this.objectMapper = objectMapper;
    }

    public void record(AdminPrincipal actor, String action, String targetType, Long targetId, Object detail) {
        try {
            AuditLog entry = new AuditLog();
            entry.setActorType(AuditLog.ACTOR_ADMIN);
            entry.setActorId(actor.adminId());
            entry.setActorName(actor.username());
            entry.setAction(action);
            entry.setTargetType(targetType);
            entry.setTargetId(targetId);
            entry.setDetail(toJson(detail));

            HttpServletRequest request = currentRequest();
            if (request != null) {
                entry.setIp(clientIp(request));
                entry.setUserAgent(truncate(request.getHeader("User-Agent"), 512));
            }
            auditLogMapper.insert(entry);
        } catch (Exception ex) {
            // 审计写入失败不应影响主流程
            log.warn("审计日志写入失败: action={}", action, ex);
        }
    }

    public List<AuditLog> search(String action, String actorName, Long orgId,
                                 OffsetDateTime from, OffsetDateTime to, int limit) {
        LambdaQueryWrapper<AuditLog> query = new LambdaQueryWrapper<AuditLog>()
                .orderByDesc(AuditLog::getId)
                .last("LIMIT " + Math.min(Math.max(limit, 1), 500));
        if (StringUtils.hasText(action)) {
            query.eq(AuditLog::getAction, action);
        }
        if (StringUtils.hasText(actorName)) {
            query.like(AuditLog::getActorName, actorName);
        }
        if (orgId != null) {
            query.eq(AuditLog::getOrgId, orgId);
        }
        if (from != null) {
            query.ge(AuditLog::getCreatedAt, from);
        }
        if (to != null) {
            query.le(AuditLog::getCreatedAt, to);
        }
        return auditLogMapper.selectList(query);
    }

    public String exportCsv(String action, String actorName, Long orgId,
                            OffsetDateTime from, OffsetDateTime to, int limit) {
        StringBuilder csv = new StringBuilder();
        csv.append(String.join(",", List.of(
                "时间", "操作人", "角色", "动作", "对象类型", "对象ID", "详情", "IP"))).append('\n');
        for (AuditLog entry : search(action, actorName, orgId, from, to, limit)) {
            csv.append(escape(entry.getCreatedAt() == null ? null : entry.getCreatedAt().toString())).append(',')
                    .append(escape(entry.getActorName())).append(',')
                    .append(escape(entry.getActorType())).append(',')
                    .append(escape(entry.getAction())).append(',')
                    .append(escape(entry.getTargetType())).append(',')
                    .append(entry.getTargetId() == null ? "" : entry.getTargetId()).append(',')
                    .append(escape(entry.getDetail())).append(',')
                    .append(escape(entry.getIp())).append('\n');
        }
        return csv.toString();
    }

    private String toJson(Object detail) {
        if (detail == null) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(detail);
        } catch (Exception ex) {
            return "{}";
        }
    }

    private HttpServletRequest currentRequest() {
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes) {
            return attributes.getRequest();
        }
        return null;
    }

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    private String truncate(String value, int max) {
        if (value == null) {
            return null;
        }
        return value.length() <= max ? value : value.substring(0, max);
    }

    private String escape(String value) {
        if (value == null) {
            return "";
        }
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }
}
