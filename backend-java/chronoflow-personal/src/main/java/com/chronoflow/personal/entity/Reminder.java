package com.chronoflow.personal.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDate;
import java.time.OffsetDateTime;

/**
 * 日程 / 待办的提醒设置（spec §4.1.2）。
 *
 * <p>{@code targetId} 是多态引用（EVENT / TASK），因此没有外键，
 * 由应用层保证目标存在且属于当前身份。
 *
 * <p>一条日程的多个提醒共用同一个 {@code sound} 与 {@code channel}（按**日程**配置，
 * 不是逐条提醒配置——见 V22 迁移的说明）。
 */
@TableName("reminder")
public class Reminder {

    public static final String TARGET_EVENT = "EVENT";
    public static final String TARGET_TASK = "TASK";

    /** 到点由服务端发推送（App 被系统杀掉也能到）。 */
    public static final String CHANNEL_PUSH = "PUSH";
    /** 由 App 排本机通知（默认；不依赖网络，也不把设备标识交给第三方）。 */
    public static final String CHANNEL_LOCAL = "LOCAL";

    public static final String SOUND_SILENT = "SILENT";
    public static final String SOUND_DEFAULT = "DEFAULT";
    public static final String SOUND_ALARM = "ALARM";

    @TableId(type = IdType.AUTO)
    private Long id;

    private String targetType;

    private Long targetId;

    private Long identityId;

    private LocalDate occurrenceDate;

    private Integer minutesBefore;

    private String channel;

    private String sound;

    private Boolean enabled;

    private OffsetDateTime sentAt;

    private OffsetDateTime createdAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getTargetType() {
        return targetType;
    }

    public void setTargetType(String targetType) {
        this.targetType = targetType;
    }

    public Long getTargetId() {
        return targetId;
    }

    public void setTargetId(Long targetId) {
        this.targetId = targetId;
    }

    public Long getIdentityId() {
        return identityId;
    }

    public void setIdentityId(Long identityId) {
        this.identityId = identityId;
    }

    public LocalDate getOccurrenceDate() {
        return occurrenceDate;
    }

    public void setOccurrenceDate(LocalDate occurrenceDate) {
        this.occurrenceDate = occurrenceDate;
    }

    public Integer getMinutesBefore() {
        return minutesBefore;
    }

    public void setMinutesBefore(Integer minutesBefore) {
        this.minutesBefore = minutesBefore;
    }

    public String getChannel() {
        return channel;
    }

    public void setChannel(String channel) {
        this.channel = channel;
    }

    public String getSound() {
        return sound;
    }

    public void setSound(String sound) {
        this.sound = sound;
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(Boolean enabled) {
        this.enabled = enabled;
    }

    public OffsetDateTime getSentAt() {
        return sentAt;
    }

    public void setSentAt(OffsetDateTime sentAt) {
        this.sentAt = sentAt;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
