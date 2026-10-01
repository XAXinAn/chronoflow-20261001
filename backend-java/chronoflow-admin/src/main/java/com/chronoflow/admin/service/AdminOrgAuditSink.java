package com.chronoflow.admin.service;

import com.chronoflow.org.service.OrgAuditSink;
import org.springframework.stereotype.Component;

/**
 * {@link OrgAuditSink} 的实现：组织管理操作落到平台共用的 {@code audit_log} 表（spec §4.3）。
 *
 * <p>审计表的实体与 mapper 在 {@code chronoflow-admin}，而操作发生在 {@code chronoflow-org}，
 * 因此由本模块提供实现、运行时被 {@code chronoflow-org} 注入。
 */
@Component
public class AdminOrgAuditSink implements OrgAuditSink {

    private final AuditLogService auditLogService;

    public AdminOrgAuditSink(AuditLogService auditLogService) {
        this.auditLogService = auditLogService;
    }

    @Override
    public void record(Long orgId,
                       String actorType,
                       Long actorId,
                       String actorName,
                       String action,
                       String targetType,
                       Long targetId,
                       Object detail) {
        auditLogService.record(actorType, actorId, actorName, orgId, action, targetType, targetId, detail);
    }
}
