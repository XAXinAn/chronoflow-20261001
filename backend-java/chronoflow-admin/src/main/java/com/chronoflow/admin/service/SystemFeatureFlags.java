package com.chronoflow.admin.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.chronoflow.admin.entity.SystemConfig;
import com.chronoflow.admin.mapper.SystemConfigMapper;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 全局配置里**真正被业务读取**的那几个功能开关（spec §5.7）。
 *
 * <p>存在的理由：`system_config` 之前只写不读，后台改了没有任何效果。把「哪些入口可见」
 * 收敛到这里之后，超管在后台的每一次改动都有可观察的结果，而不是对着一堆没人读的键值发呆。
 *
 * <p>读不到 / 值不合法一律**按开**：开关是「关掉某个入口」用的，默认值反过来
 * 会让一次数据库抖动直接把功能藏起来，用户只会以为 App 坏了。
 */
@Component
public class SystemFeatureFlags {

    /** 配置键 → 客户端字段名。键名带前缀是为了和将来别的配置区分开。 */
    private static final Map<String, String> KEYS = Map.of(
            "feature.feedback.enabled", "feedback",
            "feature.realname.enabled", "realName",
            "feature.email_binding.enabled", "emailBinding",
            "feature.agent.enabled", "agent");

    private final SystemConfigMapper systemConfigMapper;

    public SystemFeatureFlags(SystemConfigMapper systemConfigMapper) {
        this.systemConfigMapper = systemConfigMapper;
    }

    /** 当前开关快照：四个键一定都在（缺的按 true）。 */
    public FeatureFlags snapshot() {
        Map<String, Boolean> values = new HashMap<>();
        KEYS.forEach((key, name) -> values.put(name, true));

        List<SystemConfig> rows = systemConfigMapper.selectList(new LambdaQueryWrapper<SystemConfig>()
                .likeRight(SystemConfig::getConfigKey, "feature."));
        for (SystemConfig row : rows) {
            String name = KEYS.get(row.getConfigKey());
            if (name == null) {
                continue;   // 超管自己建的其它 key：不参与下发，交给各自的功能去读
            }
            values.put(name, parseBoolean(row.getConfigValue()));
        }
        return new FeatureFlags(values.get("feedback"), values.get("realName"),
                values.get("emailBinding"), values.get("agent"));
    }

    /** 只认 JSON 的 true/false 与字符串 "true"/"false"；其余（含 null）按开。 */
    private static boolean parseBoolean(String raw) {
        if (raw == null) {
            return true;
        }
        String text = raw.trim();
        if ("true".equalsIgnoreCase(text) || "\"true\"".equalsIgnoreCase(text)) {
            return true;
        }
        if ("false".equalsIgnoreCase(text) || "\"false\"".equalsIgnoreCase(text)) {
            return false;
        }
        return true;
    }

    /**
     * 客户端可见的功能开关。
     *
     * @param feedback     意见反馈入口是否可见
     * @param realName     实名认证入口是否可见
     * @param emailBinding 邮箱绑定入口是否可见
     * @param agent        小安是否可用（与 {@code /system/info} 的 aiAgentEnabled 同义）
     */
    public record FeatureFlags(boolean feedback, boolean realName, boolean emailBinding, boolean agent) {
    }
}
