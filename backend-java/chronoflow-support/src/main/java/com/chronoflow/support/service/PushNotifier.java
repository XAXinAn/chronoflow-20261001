package com.chronoflow.support.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.auth.entity.Identity;
import com.chronoflow.auth.mapper.IdentityMapper;
import com.chronoflow.support.push.PushProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;
import java.util.Map;

/**
 * 业务侧发推送的入口（spec §4.5）。
 *
 * <p>只认**身份 id**，不认组织/成员 —— 组织侧自己把「收件人」翻译成身份 id 再调这里，
 * 这样 chronoflow-support 不必反向依赖 chronoflow-org。
 *
 * <p>三条硬规则：
 * <ol>
 *   <li>**推送失败绝不抛出**：发不出去是常态（没装 App、被系统杀、没配通道），
 *       绝不能让「下发组织日程」这种业务操作跟着失败；</li>
 *   <li>尊重 `identity.notification_prefs` 里的类型开关（spec §4.5「用户可按类型开关」）；</li>
 *   <li>通道说标识失效就顺手停用，避免每次推送都重复失败。</li>
 * </ol>
 */
@Service
public class PushNotifier {

    private static final Logger log = LoggerFactory.getLogger(PushNotifier.class);

    /** 通知类型 → notification_prefs 里的开关名。缺省视为开启。 */
    public static final String TYPE_ORG_EVENT = "orgEvent";
    public static final String TYPE_EVENT_REMINDER = "eventReminder";
    public static final String TYPE_TASK_REMINDER = "taskReminder";

    private final PushProvider provider;
    private final PushDeviceService devices;
    private final IdentityMapper identityMapper;
    private final ObjectMapper objectMapper;

    public PushNotifier(PushProvider provider,
                        PushDeviceService devices,
                        IdentityMapper identityMapper,
                        ObjectMapper objectMapper) {
        this.provider = provider;
        this.devices = devices;
        this.identityMapper = identityMapper;
        this.objectMapper = objectMapper;
    }

    /**
     * 给一批身份发通知。返回实际请求到的设备数（0 表示没人订阅/没配通道，都不算错误）。
     */
    public int notifyIdentities(List<Long> identityIds, String type, String title, String body,
                                Map<String, String> extras) {
        try {
            List<Long> targets = identityIds == null ? List.of() : identityIds.stream()
                    .filter(java.util.Objects::nonNull)
                    .distinct()
                    .filter(id -> !notificationsDisabled(id, type))
                    .toList();
            if (targets.isEmpty()) {
                return 0;
            }
            // 身份 → 账号：推送设备挂在账号上（用户在个人身份下上报，组织日程要推给同一个人的组织身份）
            List<Long> accountIds = targets.stream()
                    .map(identityMapper::selectById)
                    .filter(java.util.Objects::nonNull)
                    .map(Identity::getAccountId)
                    .distinct()
                    .toList();
            if (accountIds.isEmpty()) {
                return 0;
            }
            List<String> registrationIds = devices.activeRegistrationIdsForAccounts(accountIds);
            if (registrationIds.isEmpty()) {
                return 0;
            }
            PushProvider.PushOutcome outcome = provider.send(
                    registrationIds, new PushProvider.PushNotification(title, body, extras));
            if (!outcome.ok()) {
                // 失败只记一笔：这是可观测性要看的指标，不是要往上抛的异常
                log.warn("推送未送达 type={} 设备数={} 原因={}", type, outcome.requested(), outcome.failureReason());
            }
            devices.disableByRegistrationIds(outcome.invalidRegistration());
            return outcome.requested();
        } catch (RuntimeException ex) {
            // 兜底：连查库都可能失败，但依然不能影响业务
            log.warn("推送流程异常 type={}", type, ex);
            return 0;
        }
    }

    /**
     * 在**事务提交后**再发推送。
     *
     * <p>为什么不能直接在上面的方法里同步发：极光是外部 HTTP 调用，慢的时候要几百毫秒到几秒，
     * 把它放在事务里会一直占着数据库连接；更重要的是，事务若回滚（比如后续步骤报错），
     * 用户已经收到「有新日程」的通知、点进去却什么都没 —— 先提交再发，才不会有这种幻影通知。
     */
    public void notifyAfterCommit(List<Long> identityIds, String type, String title, String body,
                                  Map<String, String> extras) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            notifyIdentities(identityIds, type, title, body, extras);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                notifyIdentities(identityIds, type, title, body, extras);
            }
        });
    }

    /** 用户关掉了这类通知？解析失败一律当作「开启」——推送比静默丢消息更容易被发现和纠正。 */
    private boolean notificationsDisabled(Long identityId, String type) {
        Identity identity = identityMapper.selectById(identityId);
        if (identity == null || identity.getNotificationPrefs() == null) {
            return false;
        }
        try {
            JsonNode prefs = objectMapper.readTree(identity.getNotificationPrefs());
            return prefs.has(type) && !prefs.path(type).asBoolean(true);
        } catch (Exception ex) {
            return false;
        }
    }

    public String providerName() {
        return provider.name();
    }

    public boolean configured() {
        return provider.configured();
    }
}
