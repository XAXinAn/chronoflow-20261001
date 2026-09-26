package com.xatodo.org.service;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * 组织管理操作的审计记录入口（spec §4.3）。
 *
 * <p>用 {@link ObjectProvider} 取出口：没有实现（例如只装配 xa-org 的场景）时静默跳过，
 * 审计不可用不应阻断管理操作本身。
 */
@Component
public class OrgAuditRecorder {

    private final ObjectProvider<OrgAuditSink> sink;

    public OrgAuditRecorder(ObjectProvider<OrgAuditSink> sink) {
        this.sink = sink;
    }

    public void record(OrgActor actor, String action, String targetType, Long targetId, Object detail) {
        OrgAuditSink available = sink.getIfAvailable();
        if (available == null || actor == null) {
            return;
        }
        if (actor.isAdminActor()) {
            available.record(actor.getOrgId(), "ADMIN", actor.getAdminId(), actor.getName(),
                    action, targetType, targetId, detail);
        } else {
            // 成员侧发起同样记 ACCOUNT：actorId 用身份 id，和登录审计的口径一致
            available.record(actor.getOrgId(), "ACCOUNT", actor.getIdentityId(), actor.getName(),
                    action, targetType, targetId, detail);
        }
    }
}
