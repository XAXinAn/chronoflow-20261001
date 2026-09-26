package com.xatodo.org.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 组织日程下发记录：描述一次下发的目标范围与状态。
 */
@TableName("event_dispatch")
public class EventDispatch {

    public static final String SCOPE_ALL = "ALL";
    public static final String SCOPE_DEPARTMENT = "DEPARTMENT";
    public static final String SCOPE_MEMBER = "MEMBER";

    public static final String STATUS_ACTIVE = "ACTIVE";
    public static final String STATUS_REVOKED = "REVOKED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long eventId;

    private Long orgId;

    private String scopeType;

    private Long departmentId;

    private Boolean includeSubDepartments;

    private Boolean requireReceipt;

    private Long createdByMemberId;

    /** 后台组织管理员（Web 组织管理端）下发时记录其 admin_user id；成员侧下发留空（spec §5.6）。 */
    private Long createdByAdminId;

    private String status;

    private Integer recipientCount;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getEventId() {
        return eventId;
    }

    public void setEventId(Long eventId) {
        this.eventId = eventId;
    }

    public Long getOrgId() {
        return orgId;
    }

    public void setOrgId(Long orgId) {
        this.orgId = orgId;
    }

    public String getScopeType() {
        return scopeType;
    }

    public void setScopeType(String scopeType) {
        this.scopeType = scopeType;
    }

    public Long getDepartmentId() {
        return departmentId;
    }

    public void setDepartmentId(Long departmentId) {
        this.departmentId = departmentId;
    }

    public Boolean getIncludeSubDepartments() {
        return includeSubDepartments;
    }

    public void setIncludeSubDepartments(Boolean includeSubDepartments) {
        this.includeSubDepartments = includeSubDepartments;
    }

    public Boolean getRequireReceipt() {
        return requireReceipt;
    }

    public void setRequireReceipt(Boolean requireReceipt) {
        this.requireReceipt = requireReceipt;
    }

    public Long getCreatedByMemberId() {
        return createdByMemberId;
    }

    public void setCreatedByMemberId(Long createdByMemberId) {
        this.createdByMemberId = createdByMemberId;
    }

    public Long getCreatedByAdminId() {
        return createdByAdminId;
    }

    public void setCreatedByAdminId(Long createdByAdminId) {
        this.createdByAdminId = createdByAdminId;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Integer getRecipientCount() {
        return recipientCount;
    }

    public void setRecipientCount(Integer recipientCount) {
        this.recipientCount = recipientCount;
    }
}
