package com.xatodo.support.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.xatodo.common.persistence.JsonbStringTypeHandler;

import java.time.OffsetDateTime;

/**
 * 意见反馈（spec §4.1.9 / §5.10）。
 *
 * <p>图片本身在文件存储里，这里只存相对 URL 数组（jsonb）。
 */
@TableName("feedback")
public class Feedback {

    public static final String STATUS_OPEN = "OPEN";
    public static final String STATUS_HANDLED = "HANDLED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long accountId;

    /** 提交时的身份：用户可能是从组织身份提的，后台得知道是哪条身份说的 */
    private Long identityId;

    private String category;

    private String content;

    @TableField(typeHandler = JsonbStringTypeHandler.class)
    private String images;

    private String status;

    private OffsetDateTime createdAt;

    private OffsetDateTime handledAt;

    private Long handledByAdminId;

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

    public Long getIdentityId() {
        return identityId;
    }

    public void setIdentityId(Long identityId) {
        this.identityId = identityId;
    }

    public String getCategory() {
        return category;
    }

    public void setCategory(String category) {
        this.category = category;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }

    public String getImages() {
        return images;
    }

    public void setImages(String images) {
        this.images = images;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public OffsetDateTime getHandledAt() {
        return handledAt;
    }

    public void setHandledAt(OffsetDateTime handledAt) {
        this.handledAt = handledAt;
    }

    public Long getHandledByAdminId() {
        return handledByAdminId;
    }

    public void setHandledByAdminId(Long handledByAdminId) {
        this.handledByAdminId = handledByAdminId;
    }
}
