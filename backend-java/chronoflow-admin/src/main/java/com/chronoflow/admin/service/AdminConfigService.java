package com.chronoflow.admin.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.admin.dto.AdminDtos.SystemConfigResponse;
import com.chronoflow.admin.dto.AdminDtos.SystemConfigUpdateRequest;
import com.chronoflow.admin.entity.SystemConfig;
import com.chronoflow.admin.mapper.SystemConfigMapper;
import com.chronoflow.admin.security.AdminPrincipal;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
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
    private final ObjectMapper objectMapper;

    public AdminConfigService(SystemConfigMapper systemConfigMapper,
                              AuditLogService auditLogService,
                              ObjectMapper objectMapper) {
        this.systemConfigMapper = systemConfigMapper;
        this.auditLogService = auditLogService;
        this.objectMapper = objectMapper;
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
        /*
         * 值要写进 jsonb 列，非法 JSON 会被数据库拒绝、报一句谁也看不懂的 SQL 错误。
         * 在这里先解析一遍，把「你写的不是合法 JSON」这句话还给超管。
         */
        try {
            objectMapper.readTree(request.configValue());
        } catch (Exception ex) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "配置值必须是合法 JSON，例如 true、\"text\"、{\"a\":1}");
        }
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

    /**
     * 删除一条配置。删掉之后读取方要能回到默认值（例如功能开关默认开），
     * 所以这里不做软删除——留着行反而会让「我明明删了」变成一个新bug。
     */
    @Transactional
    public void delete(AdminPrincipal principal, String key) {
        SystemConfig config = systemConfigMapper.selectOne(new LambdaQueryWrapper<SystemConfig>()
                .eq(SystemConfig::getConfigKey, key));
        if (config == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "配置项不存在: " + key);
        }
        systemConfigMapper.deleteById(config.getId());
        auditLogService.record(principal, "SYSTEM_CONFIG_DELETE", "SYSTEM_CONFIG", config.getId(),
                Map.of("key", key));
    }
}
