package com.chronoflow.admin.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.chronoflow.common.persistence.JsonbStringTypeHandler;

import java.time.OffsetDateTime;

/**
 * 全局配置，值以 jsonb 存储（spec §5.7）。
 */
@TableName("system_config")
public class SystemConfig {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String configKey;

    @TableField(typeHandler = JsonbStringTypeHandler.class)
    private String configValue;

    private String description;

    private Long updatedByAdminId;

    private OffsetDateTime updatedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getConfigKey() {
        return configKey;
    }

    public void setConfigKey(String configKey) {
        this.configKey = configKey;
    }

    public String getConfigValue() {
        return configValue;
    }

    public void setConfigValue(String configValue) {
        this.configValue = configValue;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public Long getUpdatedByAdminId() {
        return updatedByAdminId;
    }

    public void setUpdatedByAdminId(Long updatedByAdminId) {
        this.updatedByAdminId = updatedByAdminId;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(OffsetDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }
}
