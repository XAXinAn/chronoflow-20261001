package com.xatodo.admin.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.admin.dto.AdminDtos.SystemConfigResponse;
import com.xatodo.admin.dto.AdminDtos.SystemConfigUpdateRequest;
import com.xatodo.admin.entity.SystemConfig;
import com.xatodo.admin.mapper.SystemConfigMapper;
import com.xatodo.admin.security.AdminPrincipal;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

/**
 * 全局配置读写。配置值以 jsonb 存储（spec §4.4）。
 */
@Service
public class AdminConfigService {

    private final SystemConfigMapper systemConfigMapper;
    private final AuditLogService auditLogService;

    public AdminConfigService(SystemConfigMapper systemConfigMapper, AuditLogService auditLogService) {
        this.systemConfigMapper = systemConfigMapper;
        this.auditLogService = auditLogService;
    }

    public List<SystemConfigResponse> list() {
        return systemConfigMapper.selectList(new LambdaQueryWrapper<SystemConfig>()
                        .orderByAsc(SystemConfig::getConfigKey))
                .stream()
                .map(config -> new SystemConfigResponse(config.getConfigKey(), config.getConfigValue(),
                        config.getDescription(), config.getUpdatedAt()))
                .toList();
    }

    /**
     * 按 key upsert。值必须是合法 JSON（如 {@code true}、{@code "text"}、{@code {"a":1}}）。
     */
    @Transactional
    public SystemConfigResponse update(AdminPrincipal principal, String key, SystemConfigUpdateRequest request) {
        SystemConfig config = systemConfigMapper.selectOne(new LambdaQueryWrapper<SystemConfig>()
                .eq(SystemConfig::getConfigKey, key));
        boolean created = config == null;
        if (created) {
            config = new SystemConfig();
            config.setConfigKey(key);
        }
        config.setConfigValue(request.configValue());
        if (StringUtils.hasText(request.description())) {
            config.setDescription(request.description());
        }
        config.setUpdatedByAdminId(principal.adminId());
        config.setUpdatedAt(OffsetDateTime.now(ZoneOffset.UTC));
        if (created) {
            systemConfigMapper.insert(config);
        } else {
            systemConfigMapper.updateById(config);
        }
        auditLogService.record(principal, "SYSTEM_CONFIG_UPDATE", "SYSTEM_CONFIG", config.getId(),
                Map.of("key", key));
        return new SystemConfigResponse(config.getConfigKey(), config.getConfigValue(),
                config.getDescription(), config.getUpdatedAt());
    }
}
