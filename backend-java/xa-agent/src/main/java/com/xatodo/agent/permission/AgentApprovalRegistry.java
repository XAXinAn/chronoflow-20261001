package com.xatodo.agent.permission;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * 授权等待表（对照 mewcode 的 `PermissionChecker` + `StreamingExecutor`）：
 * 写工具在 agent 循环里**发一条授权请求就挂起等待**用户的答复，
 * 答复从另一个请求（`POST /ai/agent/approvals`）进来，这里把两边接上。
 *
 * <p>为什么值得让流挂着等：这样「助手发起工具调用 → 用户批准 → 工具真正执行 → 结果写回工具结果」
 * 全在**同一条对话流**里走完。上一版把写操作交给 App 用 REST 执行、结果下一轮再回传，
 * 于是历史里丢了工具调用、授权卡片会重复出现，用户点「拒绝」还会因为动作 id 重号而没反应。
 *
 * <p>**等待不占线程**：这里交出的是 {@link CompletableFuture}，不是「阻塞在这里等一个人点按钮」。
 * 上一版用 `future.get(200ms)` 轮询着等——一次等待要白醒 450 次，而且那根线程从头到尾被占着；
 * 换成 future 之后，答复（或超时 / 断开）才会把 agent 循环叫醒，中间不耗任何线程。
 */
@Component
public class AgentApprovalRegistry {

    private static final Logger log = LoggerFactory.getLogger(AgentApprovalRegistry.class);

    /** 用户对一次授权的答复。 */
    public record Decision(boolean allowed, String feedback) {

        /** 没有明确答复时的统一结果：超时、客户端断开、账号对不上，一律按拒绝走。 */
        public static Decision denied() {
            return new Decision(false, "");
        }
    }

    private record Pending(long accountId, CompletableFuture<Decision> future) {
    }

    private final Map<String, Pending> waiting = new ConcurrentHashMap<>();

    /**
     * 登记一次等待，返回**不阻塞**的答复凭据。
     *
     * <p>三种情况都会让这个 future 以「拒绝」完成，一个都不能少：
     * 用户点了拒绝（{@link #resolve}）、超时（这里挂的 {@code completeOnTimeout}）、
     * 客户端断开（{@link #cancel}）。宁可什么都不做，也不能因为没人回答就把日程写进去。
     *
     * @param timeout 等用户答复的上限；超时按**拒绝**处理，模型据此收尾
     */
    public CompletableFuture<Decision> register(long accountId, String actionId, Duration timeout) {
        CompletableFuture<Decision> future = new CompletableFuture<>();
        waiting.put(actionId, new Pending(accountId, future));
        // 清理由 future 自己负责：无论从哪条路径完成，登记都不会留在这个表里
        future.whenComplete((decision, error) -> waiting.remove(actionId));
        future.completeOnTimeout(Decision.denied(),
                Math.max(1, timeout.toMillis()), TimeUnit.MILLISECONDS);
        return future;
    }

    /**
     * 客户端断开（或用户点了停止）：不会有人再答复了，立刻按拒绝收尾。
     *
     * <p>少了这一步，一条断掉的流还会挂着等满 90 秒才收尾（实测卡过好几分钟）。
     */
    public void cancel(String actionId) {
        Pending pending = waiting.remove(actionId);
        if (pending != null) {
            log.info("客户端已断开，这次授权按拒绝收尾：{}", actionId);
            pending.future().complete(Decision.denied());
        }
    }

    /**
     * 用户点了允许 / 拒绝。找不到（比如已经超时）就忽略。
     *
     * <p>**先摘牌再答复**：调用方拿到 true 就说明等待表里已经没有这一条了，
     * 不依赖 `whenComplete` 什么时候跑（那是另一个线程的事）。
     */
    public boolean resolve(long accountId, String actionId, boolean allow, String feedback) {
        Pending pending = waiting.get(actionId);
        if (pending == null || pending.accountId() != accountId) {
            return false;
        }
        waiting.remove(actionId, pending);
        return pending.future().complete(new Decision(allow, feedback == null ? "" : feedback));
    }

    /** 当前正在等用户答复的授权 id（排查与测试用）。 */
    public Set<String> pendingActionIds() {
        return Set.copyOf(waiting.keySet());
    }
}
