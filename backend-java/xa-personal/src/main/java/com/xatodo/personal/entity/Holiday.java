package com.xatodo.personal.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDate;
import java.time.OffsetDateTime;

/**
 * 节假日与调休（spec §5.11）。
 *
 * <p>数据在库里、不在代码里：换一年、改一次调休安排都只是数据变更。
 */
@TableName("holiday")
public class Holiday {

    /** 放假。 */
    public static final String TYPE_HOLIDAY = "HOLIDAY";
    /** 调休上班：被调成工作日的周末与调休上班日。 */
    public static final String TYPE_WORKDAY = "WORKDAY";

    @TableId(type = IdType.AUTO)
    private Long id;

    private String countryCode;

    /** 用 LocalDate 而不是时刻：节假日是「哪一天」，与时区无关（见 V11 迁移注释）。 */
    private LocalDate holidayDate;

    private String name;

    private String dayType;

    private OffsetDateTime createdAt;

    private OffsetDateTime updatedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getCountryCode() {
        return countryCode;
    }

    public void setCountryCode(String countryCode) {
        this.countryCode = countryCode;
    }

    public LocalDate getHolidayDate() {
        return holidayDate;
    }

    public void setHolidayDate(LocalDate holidayDate) {
        this.holidayDate = holidayDate;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDayType() {
        return dayType;
    }

    public void setDayType(String dayType) {
        this.dayType = dayType;
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
