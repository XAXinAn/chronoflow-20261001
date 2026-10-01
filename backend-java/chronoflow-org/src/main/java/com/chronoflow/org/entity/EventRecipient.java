package com.chronoflow.org.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDate;
import java.time.OffsetDateTime;

/**
 * 下发到成员级别的快照记录。下发时展开，后续新入组成员不会补收历史日程。
 */
@TableName("event_recipient")
public class EventRecipient {

    public static final String PENDING = "PENDING";
    public static final String ACCEPTED = "ACCEPTED";
    public static final String DECLINED = "DECLINED";
    public static final String COMPLETED = "COMPLETED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long dispatchId;

    private Long eventId;

    private Long orgMemberId;

    private Long departmentId;

    private String receiptStatus;

    private OffsetDateTime receiptAt;

    private String remark;

    private OffsetDateTime readAt;

    private LocalDate occurrenceDate;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getDispatchId() {
        return dispatchId;
    }

    public void setDispatchId(Long dispatchId) {
        this.dispatchId = dispatchId;
    }

    public Long getEventId() {
        return eventId;
    }

    public void setEventId(Long eventId) {
        this.eventId = eventId;
    }

    public Long getOrgMemberId() {
        return orgMemberId;
    }

    public void setOrgMemberId(Long orgMemberId) {
        this.orgMemberId = orgMemberId;
    }

    public Long getDepartmentId() {
        return departmentId;
    }

    public void setDepartmentId(Long departmentId) {
        this.departmentId = departmentId;
    }

    public String getReceiptStatus() {
        return receiptStatus;
    }

    public void setReceiptStatus(String receiptStatus) {
        this.receiptStatus = receiptStatus;
    }

    public OffsetDateTime getReceiptAt() {
        return receiptAt;
    }

    public void setReceiptAt(OffsetDateTime receiptAt) {
        this.receiptAt = receiptAt;
    }

    public String getRemark() {
        return remark;
    }

    public void setRemark(String remark) {
        this.remark = remark;
    }

    public OffsetDateTime getReadAt() {
        return readAt;
    }

    public void setReadAt(OffsetDateTime readAt) {
        this.readAt = readAt;
    }

    public LocalDate getOccurrenceDate() {
        return occurrenceDate;
    }

    public void setOccurrenceDate(LocalDate occurrenceDate) {
        this.occurrenceDate = occurrenceDate;
    }
}
