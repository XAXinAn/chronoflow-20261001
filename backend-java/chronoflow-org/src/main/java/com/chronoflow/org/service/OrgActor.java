package com.chronoflow.org.service;

import com.chronoflow.org.entity.OrgMember;

import java.util.Set;

/**
 * 组织管理操作的执行者（spec §3.2 / §4.3）。两种来源：
 *
 * <ol>
 *   <li>App 里的**组织身份**（{@code org_member}）——成员用「组织唯一 ID + 唯一识别 ID」认领后得到的令牌；</li>
 *   <li>Web 组织管理端的**后台管理员**（{@code admin_user}，{@code role=ORG_ADMIN}）。</li>
 * </ol>
 *
 * <p>后台管理员在组织里没有 {@code org_member} 记录，因此 {@code memberId} / {@code identityId} 为空、
 * 部门范围是整个组织。之所以要有这一层：新组织建好时成员数为 0，若管理入口只能由成员发起，
 * 新组织就永远开不了张（spec §4.3「首位成员从哪来」）。
 */
public final class OrgActor {

    /** 后台管理员在组织内的角色口径：等同于组织管理员。 */
    public static final String ADMIN_ROLE = OrgMember.ROLE_ADMIN;

    private final Long orgId;
    private final Long memberId;
    private final Long identityId;
    private final Long adminId;
    private final String orgRole;
    private final Long departmentId;
    private final String name;
    private final Set<Long> manageableDepartmentIds;

    private OrgActor(Long orgId,
                     Long memberId,
                     Long identityId,
                     Long adminId,
                     String orgRole,
                     Long departmentId,
                     String name,
                     Set<Long> manageableDepartmentIds) {
        this.orgId = orgId;
        this.memberId = memberId;
        this.identityId = identityId;
        this.adminId = adminId;
        this.orgRole = orgRole;
        this.departmentId = departmentId;
        this.name = name;
        this.manageableDepartmentIds = manageableDepartmentIds;
    }

    public static OrgActor ofMember(OrgMember member, Set<Long> manageableDepartmentIds) {
        return new OrgActor(member.getOrgId(), member.getId(), member.getIdentityId(), null,
                member.getOrgRole(), member.getDepartmentId(), member.getRealName(),
                manageableDepartmentIds);
    }

    public static OrgActor ofAdmin(Long adminId, String username, Long orgId,
                                   Set<Long> manageableDepartmentIds) {
        return new OrgActor(orgId, null, null, adminId, ADMIN_ROLE, null, username,
                manageableDepartmentIds);
    }

    public Long getOrgId() {
        return orgId;
    }

    /** 组织成员 id；后台管理员为空。 */
    public Long getId() {
        return memberId;
    }

    public Long getMemberId() {
        return memberId;
    }

    /** C 端身份 id；后台管理员为空。 */
    public Long getIdentityId() {
        return identityId;
    }

    /** 后台管理员 id；组织成员为空。 */
    public Long getAdminId() {
        return adminId;
    }

    public String getOrgRole() {
        return orgRole;
    }

    public Long getDepartmentId() {
        return departmentId;
    }

    /** 展示名：成员是姓名，后台管理员是用户名。 */
    public String getName() {
        return name;
    }

    public Set<Long> manageableDepartmentIds() {
        return manageableDepartmentIds;
    }

    /** 是否来自 Web 组织管理端的后台管理员。 */
    public boolean isAdminActor() {
        return adminId != null;
    }

    public boolean isOrgAdmin() {
        return OrgMember.ROLE_OWNER.equals(orgRole) || OrgMember.ROLE_ADMIN.equals(orgRole);
    }
}
