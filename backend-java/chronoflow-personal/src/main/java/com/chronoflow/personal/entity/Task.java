package com.chronoflow.personal.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;
import com.chronoflow.common.persistence.JsonbStringTypeHandler;

import java.time.OffsetDateTime;

/**
 * 待办：有完成状态、可无时间的任务，支持一层子任务（spec §5.5）。
 */
@TableName("task")
public class Task {

    public static final String STATUS_TODO = "TODO";
    public static final String STATUS_DONE = "DONE";
    public static final String STATUS_CANCELLED = "CANCELLED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long calendarId;

    private Long ownerIdentityId;

    private Long orgId;

    private Long parentTaskId;

    /**
     * 关联的日程（一个日程可关联多个待办，spec §4.1.6）。
     *
     * <p>同样需要 ALWAYS：解除关联时要把这一列写成 null，
     * 而 updateById 默认会忽略 null 字段，那就成了「解绑按钮点了没用」。
     */
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private Long eventId;

    private String title;

    private String description;

    /**
     * 截断更新必须能写入 null：MyBatis-Plus 的 updateById 默认忽略 null 字段，
     * 会导致「清空截止时间 / 取消完成」看起来成功、实际没落库。
     * 这些更新都是「先读出完整实体再改再写回」，因此全量写回是安全的。
     */
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private OffsetDateTime dueAt;

    private String status;

    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private OffsetDateTime completedAt;

    private String priority;

    private String rrule;

    /** 图片附件的相对 URL 数组（jsonb，spec §4.1.3）。 */
    @TableField(typeHandler = JsonbStringTypeHandler.class)
    private String images;

    private Integer sortOrder;

    private OffsetDateTime createdAt;

    private OffsetDateTime updatedAt;

    private OffsetDateTime deletedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getCalendarId() {
        return calendarId;
    }

    public void setCalendarId(Long calendarId) {
        this.calendarId = calendarId;
    }

    public Long getOwnerIdentityId() {
        return ownerIdentityId;
    }

    public void setOwnerIdentityId(Long ownerIdentityId) {
        this.ownerIdentityId = ownerIdentityId;
    }

    public Long getOrgId() {
        return orgId;
    }

    public void setOrgId(Long orgId) {
        this.orgId = orgId;
    }

    public Long getParentTaskId() {
        return parentTaskId;
    }

    public void setParentTaskId(Long parentTaskId) {
        this.parentTaskId = parentTaskId;
    }

    public Long getEventId() {
        return eventId;
    }

    public void setEventId(Long eventId) {
        this.eventId = eventId;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public OffsetDateTime getDueAt() {
        return dueAt;
    }

    public void setDueAt(OffsetDateTime dueAt) {
        this.dueAt = dueAt;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public OffsetDateTime getCompletedAt() {
        return completedAt;
    }

    public void setCompletedAt(OffsetDateTime completedAt) {
        this.completedAt = completedAt;
    }

    public String getPriority() {
        return priority;
    }

    public void setPriority(String priority) {
        this.priority = priority;
    }

    public String getRrule() {
        return rrule;
    }

    public void setRrule(String rrule) {
        this.rrule = rrule;
    }

    public String getImages() {
        return images;
    }

    public void setImages(String images) {
        this.images = images;
    }

    public Integer getSortOrder() {
        return sortOrder;
    }

    public void setSortOrder(Integer sortOrder) {
        this.sortOrder = sortOrder;
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

    public OffsetDateTime getDeletedAt() {
        return deletedAt;
    }

    public void setDeletedAt(OffsetDateTime deletedAt) {
        this.deletedAt = deletedAt;
    }
}
