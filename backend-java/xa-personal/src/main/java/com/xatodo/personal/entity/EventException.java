package com.xatodo.personal.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDate;
import java.time.OffsetDateTime;

/**
 * 重复日程的例外：单独修改或取消某一次实例，不影响其余实例（spec §4.1.2）。
 */
@TableName("event_exception")
public class EventException {

    public static final String MODIFIED = "MODIFIED";
    public static final String CANCELLED = "CANCELLED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long eventId;

    private LocalDate occurrenceDate;

    private String exceptionType;

    private OffsetDateTime overrideStartAt;

    private OffsetDateTime overrideEndAt;

    private String overrideTitle;

    private OffsetDateTime createdAt;

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

    public LocalDate getOccurrenceDate() {
        return occurrenceDate;
    }

    public void setOccurrenceDate(LocalDate occurrenceDate) {
        this.occurrenceDate = occurrenceDate;
    }

    public String getExceptionType() {
        return exceptionType;
    }

    public void setExceptionType(String exceptionType) {
        this.exceptionType = exceptionType;
    }

    public OffsetDateTime getOverrideStartAt() {
        return overrideStartAt;
    }

    public void setOverrideStartAt(OffsetDateTime overrideStartAt) {
        this.overrideStartAt = overrideStartAt;
    }

    public OffsetDateTime getOverrideEndAt() {
        return overrideEndAt;
    }

    public void setOverrideEndAt(OffsetDateTime overrideEndAt) {
        this.overrideEndAt = overrideEndAt;
    }

    public String getOverrideTitle() {
        return overrideTitle;
    }

    public void setOverrideTitle(String overrideTitle) {
        this.overrideTitle = overrideTitle;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
