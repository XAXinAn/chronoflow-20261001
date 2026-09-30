package com.xatodo.bootstrap;

import com.xatodo.agent.permission.AgentApprovalRegistry;
import com.xatodo.agent.permission.AgentApprovalRegistry.Decision;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 授权等待表（spec §11 阶段三）。
 *
 * <p>这个类的语义是「等一个人点按钮，但**不占线程**、也**不会漏**」：
 * 交出的是 future，四种收尾（允许 / 拒绝 / 超时 / 客户端断开）都必须让等待结束、
 * 并且把登记从表里清干净——留一条在表里，就意味着有人的对话挂在那里没人应答。
 */
class AgentApprovalRegistryTest {

    private final AgentApprovalRegistry registry = new AgentApprovalRegistry();

    private CompletableFuture<Decision> pending(String actionId) {
        return registry.register(7L, actionId, Duration.ofSeconds(30));
    }

    @Test
    @DisplayName("用户点允许：按答复完成，并立刻从等待表里消失")
    void resolveCompletesTheWait() {
        CompletableFuture<Decision> awaited = pending("a1");
        assertThat(registry.pendingActionIds()).containsExactly("a1");

        assertThat(registry.resolve(7L, "a1", true, null)).isTrue();
        assertThat(awaited.isDone()).isTrue();
        assertThat(awaited.join().allowed()).isTrue();
        assertThat(awaited.join().feedback()).isEmpty();
        assertThat(registry.pendingActionIds()).isEmpty();
    }

    @Test
    @DisplayName("拒绝时带上用户的补充说明，一起回灌给模型")
    void resolveCarriesFeedback() {
        CompletableFuture<Decision> awaited = pending("a1");

        assertThat(registry.resolve(7L, "a1", false, "改成四点")).isTrue();
        assertThat(awaited.join().allowed()).isFalse();
        assertThat(awaited.join().feedback()).isEqualTo("改成四点");
        assertThat(registry.pendingActionIds()).isEmpty();
    }

    @Test
    @DisplayName("别人的答复不算数：账号对不上就不放行，等待继续挂着")
    void resolveIgnoresOtherAccounts() {
        CompletableFuture<Decision> awaited = pending("a1");

        assertThat(registry.resolve(8L, "a1", true, null)).isFalse();
        assertThat(awaited.isDone()).isFalse();
        assertThat(registry.pendingActionIds()).containsExactly("a1");
    }

    @Test
    @DisplayName("客户端断开：立刻按拒绝收尾，不用干等满 90 秒")
    void cancelDeniesImmediately() {
        CompletableFuture<Decision> awaited = pending("a1");

        registry.cancel("a1");

        assertThat(awaited.isDone()).isTrue();
        assertThat(awaited.join().allowed()).isFalse();
        assertThat(registry.pendingActionIds()).isEmpty();
        // 已经断掉的那次等待，后面来的「允许」也救不回来
        assertThat(registry.resolve(7L, "a1", true, null)).isFalse();
    }

    @Test
    @DisplayName("没人答就是拒绝：超时同样收尾，且不留在等待表里")
    void timeoutDeniesAndClears() throws Exception {
        CompletableFuture<Decision> awaited = registry.register(7L, "a1", Duration.ofMillis(50));

        // 超时是**正常完成**（值是拒绝），不是异常——调用方不用处理 TimeoutException
        assertThat(awaited.join().allowed()).isFalse();
        awaitPendingCleared();
    }

    @Test
    @DisplayName("答过一次就没了：重复答复不会第二次放行")
    void resolveIsIdempotent() {
        pending("a1");

        assertThat(registry.resolve(7L, "a1", true, null)).isTrue();
        assertThat(registry.resolve(7L, "a1", true, null)).isFalse();
        assertThat(registry.pendingActionIds()).isEmpty();
    }

    /** 超时那条路由 future 自己清理，落地时间取决于调度线程；这里给它一点时间。 */
    private void awaitPendingCleared() throws InterruptedException {
        for (int i = 0; i < 100 && !registry.pendingActionIds().isEmpty(); i++) {
            Thread.sleep(10);
        }
        assertThat(registry.pendingActionIds()).isEmpty();
    }
}
