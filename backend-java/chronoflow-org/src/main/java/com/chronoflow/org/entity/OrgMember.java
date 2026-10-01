package com.chronoflow.org.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.OffsetDateTime;

/**
 * 组织成员关系：组织里的一名人员（spec §5.4）。
 *
 * <p>注意它**不依赖身份**：管理员导入成员时只写 {@code memberKey}（学号/工号），
 * {@code identityId} 要等成员自己在 App 里认领组织账号时才回填。
 * 这样组织侧的人员管理不必等任何人注册，也不会再出现「首位成员建不出来」。
 */
@TableName("org_member")
public class OrgMember {

    public static final String ROLE_OWNER = "OWNER";
    public static final String ROLE_ADMIN = "ADMIN";
    public static final String ROLE_MEMBER = "MEMBER";

    public static final String STATUS_ACTIVE = "ACTIVE";
    public static final String STATUS_DISABLED = "DISABLED";
    public static final String STATUS_LEFT = "LEFT";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long orgId;

    /**
     * 认领后指向该成员的组织身份；未认领时为 null。
     *
     * <p>必须声明 ALWAYS：解绑时要把这一列写回 null，而 updateById 默认忽略 null 字段，
     * 那样「解绑」就会变成「接口返回成功、认领关系还在」。
     */
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private Long identityId;

    private Long departmentId;

    /** 成员唯一识别 ID（学号/工号），组织内唯一，也是登录组织账号的凭据之一 */
    private String memberKey;

    private String realName;

    private String orgRole;

    private String jobTitle;

    private String status;

    /** 最近一次认领/登录组织账号的时间，供 App「账户管理」展示 */
    private OffsetDateTime lastLoginAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getOrgId() {
        return orgId;
    }

    public void setOrgId(Long orgId) {
        this.orgId = orgId;
    }

    public Long getIdentityId() {
        return identityId;
    }

    public void setIdentityId(Long identityId) {
        this.identityId = identityId;
    }

    public Long getDepartmentId() {
        return departmentId;
    }

    public void setDepartmentId(Long departmentId) {
        this.departmentId = departmentId;
    }

    public String getMemberKey() {
        return memberKey;
    }

    public void setMemberKey(String memberKey) {
        this.memberKey = memberKey;
    }

    public OffsetDateTime getLastLoginAt() {
        return lastLoginAt;
    }

    public void setLastLoginAt(OffsetDateTime lastLoginAt) {
        this.lastLoginAt = lastLoginAt;
    }

    public String getRealName() {
        return realName;
    }

    public void setRealName(String realName) {
        this.realName = realName;
    }

    public String getOrgRole() {
        return orgRole;
    }

    public void setOrgRole(String orgRole) {
        this.orgRole = orgRole;
    }

    public String getJobTitle() {
        return jobTitle;
    }

    public void setJobTitle(String jobTitle) {
        this.jobTitle = jobTitle;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }
}
