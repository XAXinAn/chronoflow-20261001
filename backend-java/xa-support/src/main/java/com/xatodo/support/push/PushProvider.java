package com.xatodo.support.push;

import java.util.List;
import java.util.Map;

/**
 * 推送通道抽象（spec §4.5：`PushProvider` 接口，首版实现对接极光）。
 *
 * <p>抽出来是为了两件事：① 将来换厂商/换通道不动业务代码；② 测试里可以换成记录型实现，
 * 不去真连极光。
 */
public interface PushProvider {

    /** 通道名，用于日志与状态上报（如 `jpush`）。 */
    String name();

    /** 是否已配置可用。未配置时上层跳过推送并如实上报，而不是抛异常打断业务流程。 */
    boolean configured();

    /**
     * 向一批设备标识发同一条通知。
     *
     * <p>**不允许抛异常**：推送失败不该让「下发组织日程」这种业务操作失败。
     * 失败原因放进返回值里，由调用方记录。
     */
    PushOutcome send(List<String> registrationIds, PushNotification notification);

    /** 一条通知的内容。extras 用于让 App 知道点开后跳哪里。 */
    record PushNotification(String title, String body, Map<String, String> extras) {
    }

    /**
     * @param requested            本次请求覆盖的设备数
     * @param invalidRegistration  通道判定为失效的标识（上层据此停用这些设备）
     * @param failureReason        null 表示成功
     */
    record PushOutcome(int requested, List<String> invalidRegistration, String failureReason) {

        public static PushOutcome skipped() {
            return new PushOutcome(0, List.of(), null);
        }

        public static PushOutcome failed(int requested, String reason) {
            return new PushOutcome(requested, List.of(), reason);
        }

        public boolean ok() {
            return failureReason == null;
        }
    }
}
