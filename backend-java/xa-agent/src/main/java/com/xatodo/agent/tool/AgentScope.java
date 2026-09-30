package com.xatodo.agent.tool;

import com.xatodo.org.entity.OrgMember;

/**
 * 助手这次能「看到」的范围（spec §11 阶段三）。
 *
 * <p>可见 = **个人日程 + 当前组织下发给我的日程**。不是「我绑定的所有组织」：
 * 跨组织合并视图还没做，助手先跟界面口径保持一致（日历页检索跨组织是另一回事）。
 *
 * @param orgMember 为空表示这次没有组织上下文（用户没选组织 / 没绑定组织）
 */
public record AgentScope(Long accountId,
                         Long personalIdentityId,
                         Long orgIdentityId,
                         Long orgId,
                         String orgName,
                         OrgMember orgMember) {

    public boolean hasOrg() {
        return orgMember != null;
    }
}
