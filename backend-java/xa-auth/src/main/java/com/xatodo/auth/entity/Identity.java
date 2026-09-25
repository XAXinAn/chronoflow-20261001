package com.xatodo.auth.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.xatodo.common.persistence.JsonbStringTypeHandler;

import java.time.OffsetDateTime;

/**
 * 身份：账号在某个空间下的操作主体，见 spec §3.1。
 *
 * <p>{@code PERSONAL} 至多 1 个且不携带组织；{@code ORG_MEMBER} 必须携带组织，每个组织至多 1 个。
 */
@TableName("identity")
public class Identity {

    public static final String TYPE_PERSONAL = "PERSONAL";
    public static final String TYPE_ORG_MEMBER = "ORG_MEMBER";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long accountId;

    private String identityType;

    private Long orgId;

    private String nickname;

    private String avatarUrl;

    private String status;

    private String timezone;

    /** 通知偏好，jsonb 字符串；按类型开关，新增类型无需改表。 */
    @TableField(typeHandler = JsonbStringTypeHandler.class)
    private String notificationPrefs;

    private OffsetDateTime createdAt;

    private OffsetDateTime updatedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getAccountId() {
        return accountId;
    }

    public void setAccountId(Long accountId) {
        this.accountId = accountId;
    }

    public String getIdentityType() {
        return identityType;
    }

    public void setIdentityType(String identityType) {
        this.identityType = identityType;
    }

    public Long getOrgId() {
        return orgId;
    }

    public void setOrgId(Long orgId) {
        this.orgId = orgId;
    }

    public String getNickname() {
        return nickname;
    }

    public void setNickname(String nickname) {
        this.nickname = nickname;
    }

    public String getAvatarUrl() {
        return avatarUrl;
    }

    public void setAvatarUrl(String avatarUrl) {
        this.avatarUrl = avatarUrl;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getTimezone() {
        return timezone;
    }

    public void setTimezone(String timezone) {
        this.timezone = timezone;
    }

    public String getNotificationPrefs() {
        return notificationPrefs;
    }

    public void setNotificationPrefs(String notificationPrefs) {
        this.notificationPrefs = notificationPrefs;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(OffsetDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }
}
