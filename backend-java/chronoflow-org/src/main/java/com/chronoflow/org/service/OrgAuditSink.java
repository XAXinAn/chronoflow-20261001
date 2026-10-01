package com.chronoflow.org.service;

/**
 * 组织管理操作写审计日志的出口（spec §4.3「操作日志」）。
 *
 * <p>{@code audit_log} 的实体与 mapper 在 {@code chronoflow-admin}，而组织管理操作发生在 {@code chronoflow-org}，
 * 且 {@code chronoflow-org} 不能依赖 {@code chronoflow-admin}（反向依赖）。因此这里只声明出口，
 * 由 {@code chronoflow-admin} 提供实现，Spring 运行时注入。
 */
public interface OrgAuditSink {

    void record(Long orgId,
                String actorType,
                Long actorId,
                String actorName,
                String action,
                String targetType,
                Long targetId,
                Object detail);
}
