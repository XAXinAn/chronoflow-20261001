package com.xatodo.agent.service;

import com.xatodo.agent.config.AgentProperties;
import com.xatodo.agent.dto.AgentAction;
import com.xatodo.agent.dto.AgentDtos.AgentChatRequest;
import com.xatodo.agent.dto.AgentDtos.ApprovalRequest;
import com.xatodo.agent.dto.AgentDtos.ChatTurn;
import com.xatodo.agent.dto.AgentDtos.DeltaEvent;
import com.xatodo.agent.dto.AgentDtos.DoneEvent;
import com.xatodo.agent.dto.AgentDtos.ErrorEvent;
import com.xatodo.agent.dto.AgentDtos.StatusEvent;
import com.xatodo.agent.dto.AgentDtos.ToolCallTurn;
import com.xatodo.agent.dto.AgentDtos.ToolEvent;
import com.xatodo.agent.dto.AgentDtos.UsagePayload;
import com.xatodo.agent.model.AgentMessage;
import com.xatodo.agent.model.AgentModelClient;
import com.xatodo.agent.model.AgentStreamAborted;
import com.xatodo.agent.model.AgentToolCall;
import com.xatodo.agent.model.CompletionRequest;
import com.xatodo.agent.model.CompletionResult;
import com.xatodo.agent.model.ModelUsage;
import com.xatodo.agent.permission.AgentApprovalRegistry;
import com.xatodo.agent.permission.AgentWriteExecutor;
import com.xatodo.agent.tool.AgentScope;
import com.xatodo.agent.tool.AgentScopeResolver;
import com.xatodo.agent.tool.AgentToolRegistry;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 「小安」的对话编排（spec §11 阶段三）。
 *
 * <p>结构照着 mewcode 的 agent 循环来（`agent/Agent` + `permission/PermissionChecker` +
 * `StreamingExecutor`），四条不变量：
 * <ol>
 *   <li>**一次对话 = 一个循环**：模型 → 工具调用 → 执行 → 把结果写回 → 再问模型，直到模型不再调工具；</li>
 *   <li>**工具在服务端执行**：读工具直接查，写工具走权限层（用户点了允许才真正落库，
 *       走的是与 REST 完全同一套 Service，隔离沙盒与校验一个不少）；</li>
 *   <li>**权限是阻塞等待**：写工具发一条授权请求就停下等用户答复（另一个请求进来 resolve），
 *       允许 → 执行并把真实结果写成 tool_result；拒绝 → 写一条「用户拒绝了、什么都没改」
 *       的 tool_result，模型在同一条流里继续；</li>
 *   <li>**历史里 tool_use 与 tool_result 永远配对**（mewcode `conversation/ToolPairing`）：
 *       客户端把工具调用与结果一起带回来，服务端发请求前再修一遍配对。
 * </ol>
 */
@Service
public class AgentChatService {

    private static final Logger log = LoggerFactory.getLogger(AgentChatService.class);

    /** 整条流的超时。要盖得住「等用户点授权」那段：mewcode 等 5 分钟，这里取同样的量级。 */
    private static final long STREAM_TIMEOUT_MS = 5 * 60_000L;
    /**
     * 等用户答复授权的上限。90 秒：面板就摆在输入框的位置，正常几秒就点了；
     * 摆太久只会在服务端占着一条连接与一个线程（原来 4.5 分钟，实测能卡住好几分钟）。
     * 超时按**拒绝**处理，模型据此收尾。
     */
    private static final Duration APPROVAL_TIMEOUT = Duration.ofSeconds(90);

    /** 用户拒绝时写回模型的工具结果（mewcode `ToolPairing.REJECTED_TOOL_RESULT` 的中文版）。 */
    private static final String REJECTED_TOOL_RESULT =
            "用户拒绝了这次操作，什么都没有改动。不要再重新申请同一个动作，"
                    + "可以用一句话说明，或者问用户要不要换个做法。";

    private final AgentProperties properties;
    private final AgentModelClient modelClient;
    private final AgentToolRegistry tools;
    private final AgentScopeResolver scopeResolver;
    private final AgentPrompt prompt;
    private final AgentApprovalRegistry approvals;
    private final AgentWriteExecutor writeExecutor;
    private final ExecutorService executor;

    public AgentChatService(AgentProperties properties,
                            AgentModelClient modelClient,
                            AgentToolRegistry tools,
                            AgentScopeResolver scopeResolver,
                            AgentPrompt prompt,
                            AgentApprovalRegistry approvals,
                            AgentWriteExecutor writeExecutor,
                            ExecutorService agentStreamExecutor) {
        this.properties = properties;
        this.modelClient = modelClient;
        this.tools = tools;
        this.scopeResolver = scopeResolver;
        this.prompt = prompt;
        this.approvals = approvals;
        this.writeExecutor = writeExecutor;
        this.executor = agentStreamExecutor;
    }

    public boolean enabled() {
        return modelClient.available();
    }

    public SseEmitter chat(Long accountId, AgentChatRequest request) {
        if (!modelClient.available()) {
            // 未配置时不开流：让 App 拿到一个正常的统一响应体
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "小安还没有接入模型");
        }
        List<ChatTurn> turns = request == null ? null : request.messages();
        if (turns == null || turns.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "缺少 messages");
        }
        // 隔离沙盒：越权校验放在建流之前，身份不对就不该开始花钱
        AgentScope scope = scopeResolver.resolve(accountId, request.orgIdentityId());

        SseEmitter emitter = new SseEmitter(STREAM_TIMEOUT_MS);
        Stream stream = new Stream(emitter, approvals);
        Session session = new Session(stream, scope, request, accountId);
        emitter.onCompletion(stream::markClosed);
        emitter.onError(error -> stream.markClosed());
        emitter.onTimeout(() -> {
            stream.markClosed();
            emitter.complete();
        });
        submit(session, () -> step(session));
        return emitter;
    }

    /** 用户点了「允许 / 拒绝」：解开正在等的那次授权。 */
    public void approve(Long accountId, ApprovalRequest request) {
        if (request == null || !StringUtils.hasText(request.actionId())) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "缺少 actionId");
        }
        boolean allow = Boolean.TRUE.equals(request.allow());
        if (!approvals.resolve(accountId, request.actionId(), allow, request.feedback())) {
            // 多半是已经超时或整条流早就结束了：不当成错误，客户端不必重试
            log.info("授权答复没有对应的等待项（已超时？）：{}", request.actionId());
        }
    }

    /**
     * 一次对话的全部可变状态。
     *
     * <p>以前这些都是 `run()` 里的局部变量，一根线程从第一轮跑到最后一轮。改成**异步等待授权**
     * 之后，会话会在授权点挂起、被答复叫醒、再接着往下跑——状态必须活过两次线程调度，
     * 所以收进这个对象里；`stateLock` 保证同一条对话永远只有一个任务在动它的状态。
     */
    private final class Session {

        /** 同一条对话的状态锁：挂起的旧任务收尾时，被叫醒的新任务要排队等它让出。 */
        final Object stateLock = new Object();

        final Stream stream;
        final AgentScope scope;
        final AgentChatRequest request;
        final long accountId;
        final ZoneId zone = ZoneId.of(properties.getTimezone());
        /** 会话开始的那一刻：提示词里的"现在"与工具解释「明天」用的是同一个时间。 */
        final Instant now = Instant.now();
        final long startedAt = System.nanoTime();
        final String userText;
        final List<AgentMessage> conversation;

        /** 收尾只做一次（日志 / error 事件）；异步化之后好几种情况都会走到收尾。 */
        final AtomicBoolean closed = new AtomicBoolean(false);

        ModelUsage usage = ModelUsage.UNKNOWN;
        int rounds;
        String finishReason = "stop";
        int toolCalls;
        int writeAttempts;
        int nudges;
        int actionSeq;

        /** 当前这一轮的工具调用与游标：在授权点挂起，被叫醒时从这里接着走。 */
        List<AgentToolCall> calls = List.of();
        int callIndex;

        Session(Stream stream, AgentScope scope, AgentChatRequest request, long accountId) {
            this.stream = stream;
            this.scope = scope;
            this.request = request;
            this.accountId = accountId;
            this.userText = lastUserText(request);
            this.conversation = buildConversation(scope, request, zone, now);
        }
    }

    /**
     * 每个「跑一段」的任务都从这里进线程池：异常出口只有一处，不会漏掉 error 事件与收尾日志。
     *
     * <p>同一会话的任务在 {@link Session#stateLock} 上串行——同一个对话不允许两段同时改状态。
     */
    private void submit(Session s, Runnable task) {
        executor.submit(() -> {
            synchronized (s.stateLock) {
                if (s.closed.get()) {
                    return;   // 收尾之后迟到的答复：这条对话已经结束了，不能再动手
                }
                try {
                    task.run();
                } catch (AgentStreamAborted aborted) {
                    s.stream.completeQuietly();
                    finish(s);
                } catch (BizException ex) {
                    s.stream.error(ex.getErrorCode().getCode(), ex.getMessage());
                    finish(s);
                } catch (Exception ex) {
                    log.error("助手对话失败", ex);
                    s.stream.error(ErrorCode.INTERNAL_ERROR.getCode(), "助手暂时不可用，请稍后再试");
                    finish(s);
                }
            }
        });
    }

    /** 会话收尾：日志只打一次，别让同一条对话在日志里出现两遍。 */
    private void finish(Session s) {
        if (!s.closed.compareAndSet(false, true)) {
            return;
        }
        long elapsedMs = (System.nanoTime() - s.startedAt) / 1_000_000;
        log.info("agent chat: prompt={}, provider={}, rounds={}, promptTokens={},"
                        + " completionTokens={}, elapsedMs={}",
                prompt.version(), modelClient.providerName(), s.rounds,
                s.usage.promptTokens(), s.usage.completionTokens(), elapsedMs);
    }

    /** agent 循环的一步：问一次模型，把它要的工具按声明顺序执行掉。 */
    private void step(Session s) {
        while (true) {
            if (s.rounds >= properties.getMaxToolRounds()) {
                // 轮次用尽：与以前 for 循环自然走完是同一个结果
                s.stream.done(s.finishReason, s.usage);
                finish(s);
                return;
            }
            s.rounds++;
            CompletionResult result = modelClient.complete(
                    new CompletionRequest(s.conversation, tools.specs()), s.stream::delta);
            s.usage = add(s.usage, result.usage());
            if (result.finishReason() != null) {
                s.finishReason = result.finishReason();
            }

            if (result.toolCalls().isEmpty()) {
                /**
                 * 兜底：用户明显是"要建 / 要改 / 要删"，模型却只用文字回了一轮。
                 *
                 * <p>**只在还没碰过写操作时**追问（`writeAttempts == 0`）：一旦写过
                 * （执行了、或被用户拒绝了），模型接下来只该描述结果，再催它「去调工具」
                 * 会把同一件事再申请一次——2026-09-29 线上就是这么冒出第二条授权行的。
                 */
                boolean writeIntent = s.writeAttempts == 0 && s.nudges == 0
                        && (s.toolCalls == 0 ? looksLikeWriteIntent(s.userText)
                                             : hasWriteVerb(s.userText));
                if (writeIntent) {
                    s.nudges++;
                    s.conversation.add(AgentMessage.system(NUDGE));
                    continue;
                }
                s.stream.done(s.finishReason, s.usage);
                finish(s);
                return;
            }

            s.conversation.add(AgentMessage.assistant(result.text(), result.toolCalls()));
            s.calls = result.toolCalls();
            s.callIndex = 0;
            if (!processCalls(s)) {
                return;   // 停在授权点上：线程交回，等人点按钮（或超时 / 断开）再接着跑
            }
        }
    }

    /**
     * 顺序处理这一轮的工具调用：读的当场查，写的先把授权请求摆给用户看。
     *
     * @return true = 这一轮走完了，可以接着问模型；false = 停在授权点上，等答复再进来
     */
    private boolean processCalls(Session s) {
        while (s.callIndex < s.calls.size()) {
            AgentToolCall call = s.calls.get(s.callIndex++);
            s.toolCalls++;

            if (tools.isReadOnly(call.name())) {
                s.stream.status(stageOf(call.name()), labelOf(call.name()));
                AgentToolRegistry.ToolOutcome outcome =
                        tools.invoke(s.scope, call, null, s.now, s.zone);
                s.stream.tool(call.id(), call.name(), call.arguments(), outcome.json(), outcome.row());
                s.conversation.add(AgentMessage.tool(call.id(), outcome.json()));
                continue;
            }

            s.writeAttempts++;
            s.actionSeq++;
            String actionId = newActionId(s.actionSeq);
            // 权限层：先把这次写操作摆给用户看，再等他答复
            AgentToolRegistry.ToolOutcome ask = tools.invoke(s.scope, call, actionId, s.now, s.zone);
            if (ask.action() == null) {
                // 参数不全 / 找不到那条日程：把错误交回模型，它会解释或改法
                s.stream.tool(call.id(), call.name(), call.arguments(), ask.json(), ask.row());
                s.conversation.add(AgentMessage.tool(call.id(), ask.json()));
                continue;
            }
            s.stream.status(stageOf(call.name()), labelOf(call.name()));
            s.stream.action(ask.action());
            suspend(s, call, ask, actionId);
            return false;
        }
        return true;
    }

    /**
     * 把这次写挂起在授权点上。
     *
     * <p>**这里不阻塞、也不占线程**：登记一份答复凭据就把线程交回去。答复从
     * `POST /ai/agent/approvals` 进来（或等超时、或客户端断开），才会把循环叫醒接着跑。
     * 上一版是就地把线程停在这里轮询着等（200ms 一次，一次等待白醒几百回）；
     * 换成 future 之后，挂着的对话在服务端不消耗任何线程。
     */
    private void suspend(Session s, AgentToolCall call,
                         AgentToolRegistry.ToolOutcome ask, String actionId) {
        // 先记下"这条流在等谁"，再登记：客户端断开时那条回调才找得到该取消哪一次等待
        s.stream.awaitApproval(actionId);
        CompletableFuture<AgentApprovalRegistry.Decision> awaited =
                approvals.register(s.accountId, actionId, APPROVAL_TIMEOUT);
        awaited.whenComplete((decision, error) -> {
            s.stream.clearApproval();
            AgentApprovalRegistry.Decision resolved =
                    decision == null ? AgentApprovalRegistry.Decision.denied() : decision;
            submit(s, () -> resume(s, call, ask, resolved));
        });
        if (s.stream.isCancelled()) {
            // 客户端在这之前就断了：这次登记不会有人来答复，主动收掉（否则白等满超时）
            approvals.cancel(actionId);
        }
    }

    /** 答复回来之后接着跑：允许就真正执行，拒绝就写一条「什么都没改」的工具结果。 */
    private void resume(Session s, AgentToolCall call,
                        AgentToolRegistry.ToolOutcome ask,
                        AgentApprovalRegistry.Decision decision) {
        if (!decision.allowed()) {
            String rejected = REJECTED_TOOL_RESULT
                    + (StringUtils.hasText(decision.feedback())
                            ? " 用户补充说：" + decision.feedback() : "");
            s.stream.tool(call.id(), call.name(), call.arguments(), rejected,
                    new AgentToolRegistry.ToolRow(false, "已拒绝", List.of(ask.action().summary())));
            s.conversation.add(AgentMessage.tool(call.id(), rejected));
        } else {
            // 允许 → 真正执行（与 REST 同一套 Service）
            AgentWriteExecutor.WriteOutcome written =
                    writeExecutor.execute(s.scope.personalIdentityId(), ask.action(), s.zone);
            s.stream.tool(call.id(), call.name(), call.arguments(), written.json(),
                    new AgentToolRegistry.ToolRow(false, written.summary(),
                            List.of(written.summary())));
            s.conversation.add(AgentMessage.tool(call.id(), written.json()));
        }
        // 这一轮剩下的调用接着走；走完了就问下一轮
        if (processCalls(s)) {
            step(s);
        }
    }

    /**
     * 组装送给模型的上下文：系统提示（来自 prompt.md）+ 客户端带回来的历史。
     *
     * <p>历史里助手消息可以带 tool_calls、后面跟 tool 消息，**发出去之前再修一遍配对**
     * （mewcode `conversation/ToolPairing.ensure`）：少了结果的工具调用补一条"执行被中断"，
     * 找不到对应调用的孤儿结果丢掉。不修的话上游会整条请求报错。
     */
    private List<AgentMessage> buildConversation(AgentScope scope, AgentChatRequest request,
                                                 ZoneId zone, Instant now) {
        List<AgentMessage> conversation = new ArrayList<>();
        conversation.add(AgentMessage.system(systemPrompt(scope, zone, now, request)));

        List<ChatTurn> turns = request.messages();
        List<ChatTurn> kept = keepRecentTurns(turns, properties.getMaxHistoryMessages());
        for (ChatTurn turn : kept) {
            if (turn == null) {
                continue;
            }
            String role = turn.role() == null ? AgentMessage.ROLE_USER : turn.role().toLowerCase();
            switch (role) {
                case AgentMessage.ROLE_ASSISTANT -> {
                    List<AgentToolCall> calls = new ArrayList<>();
                    if (turn.toolCalls() != null) {
                        for (ToolCallTurn call : turn.toolCalls()) {
                            if (call != null && StringUtils.hasText(call.name())) {
                                calls.add(new AgentToolCall(call.id(), call.name(), call.arguments()));
                            }
                        }
                    }
                    if (calls.isEmpty() && !StringUtils.hasText(turn.content())) {
                        continue;
                    }
                    conversation.add(AgentMessage.assistant(turn.content(), calls));
                }
                case AgentMessage.ROLE_TOOL -> {
                    if (StringUtils.hasText(turn.toolCallId())) {
                        conversation.add(AgentMessage.tool(turn.toolCallId(), turn.content()));
                    }
                }
                default -> {
                    if (StringUtils.hasText(turn.content())) {
                        conversation.add(AgentMessage.user(turn.content()));
                    }
                }
            }
        }
        return repairPairs(conversation);
    }

    /**
     * 只保留最近 N 条消息，但**不能把配对切散**：往前多留几条直到所有工具调用都还带着结果。
     */
    private static List<ChatTurn> keepRecentTurns(List<ChatTurn> turns, int keep) {
        int from = Math.max(0, turns.size() - Math.max(1, keep));
        // 从切点往后走：只要出现 tool 角色，就把切点继续前移（它的调用在更前面）
        while (from > 0 && from < turns.size()) {
            String role = turns.get(from) == null || turns.get(from).role() == null
                    ? "" : turns.get(from).role().toLowerCase();
            if (AgentMessage.ROLE_TOOL.equals(role)) {
                from--;
            } else {
                break;
            }
        }
        return turns.subList(from, turns.size());
    }

    /** mewcode `ToolPairing.ensure` 的等价实现：补齐没结果的工具调用、丢掉孤儿结果。 */
    private static List<AgentMessage> repairPairs(List<AgentMessage> messages) {
        Set<String> resolved = new HashSet<>();
        Set<String> issued = new HashSet<>();
        for (AgentMessage message : messages) {
            if (message.toolCallId() != null) {
                resolved.add(message.toolCallId());
            }
            for (AgentToolCall call : message.toolCalls()) {
                issued.add(call.id());
            }
        }
        List<AgentMessage> repaired = new ArrayList<>(messages.size());
        for (AgentMessage message : messages) {
            if (message.toolCallId() != null && !issued.contains(message.toolCallId())) {
                continue;   // 孤儿工具结果：丢掉
            }
            repaired.add(message);
            for (AgentToolCall call : message.toolCalls()) {
                if (!resolved.contains(call.id())) {
                    repaired.add(AgentMessage.tool(call.id(),
                            "{\"status\":\"interrupted\",\"note\":\"这次工具调用没有拿到结果，"
                                    + "可能被中断了；不要假设它已经生效\"}"));
                    resolved.add(call.id());
                }
            }
        }
        return repaired;
    }

    /**
     * 渲染系统提示：环境事实由服务端注入，行为规格全部来自 prompt.md。
     */
    private String systemPrompt(AgentScope scope, ZoneId zone, Instant now,
                                AgentChatRequest request) {
        ZonedDateTime local = now.atZone(zone);
        String weekday = "周" + "日一二三四五六".charAt(local.getDayOfWeek().getValue() % 7);
        String orgLine = scope.hasOrg()
                ? "用户当前正在「" + scope.orgName() + "」这个组织里，但你只能操作他个人的日程。"
                : "用户当前没有选择组织。";

        return prompt.render(Map.of(
                "today", local.toLocalDate().toString(),
                "weekday", weekday,
                "now", String.format("%02d:%02d", local.getHour(), local.getMinute()),
                "timezone", zone.getId(),
                "org_line", orgLine));
    }

    /**
     * 一次请求里给授权动作生成 id。
     *
     * <p>**必须全局唯一**，不能像原来那样每轮都从 a1 开始：客户端按 id 认卡片，
     * 跨轮重号会让第二次的「拒绝」命中第一条（已处理）的卡片而直接返回——
     * 用户点拒绝没有任何反应（2026-09-29 实测）。
     */
    private static String newActionId(int seq) {
        return "a" + Long.toString(System.nanoTime(), 36) + "-" + seq;
    }

    /** 查询类工具在动手前先告诉用户"正在做什么"。 */
    private static String stageOf(String toolName) {
        return switch (toolName == null ? "" : toolName) {
            case AgentToolRegistry.LIST_MY_EVENTS, AgentToolRegistry.READ_MY_EVENT_NOTE -> "querying_events";
            case AgentToolRegistry.CREATE_MY_EVENT -> "preparing_create";
            case AgentToolRegistry.UPDATE_MY_EVENT -> "preparing_update";
            case AgentToolRegistry.DELETE_MY_EVENT -> "preparing_delete";
            default -> "working";
        };
    }

    private static String labelOf(String toolName) {
        return switch (toolName == null ? "" : toolName) {
            case AgentToolRegistry.LIST_MY_EVENTS -> "正在查日程…";
            case AgentToolRegistry.READ_MY_EVENT_NOTE -> "正在读备注…";
            case AgentToolRegistry.CREATE_MY_EVENT -> "正在准备创建…";
            case AgentToolRegistry.UPDATE_MY_EVENT -> "正在准备修改…";
            case AgentToolRegistry.DELETE_MY_EVENT -> "正在准备删除…";
            default -> "正在处理…";
        };
    }

    private static ModelUsage add(ModelUsage total, ModelUsage extra) {
        if (extra == null) {
            return total;
        }
        return new ModelUsage(
                total.promptTokens() + extra.promptTokens(),
                total.completionTokens() + extra.completionTokens());
    }

    /** 用户这一轮最后说了什么（兜底追问的判定用它）。 */
    private static String lastUserText(AgentChatRequest request) {
        List<ChatTurn> turns = request.messages();
        if (turns == null || turns.isEmpty()) {
            return "";
        }
        for (int i = turns.size() - 1; i >= 0; i--) {
            ChatTurn turn = turns.get(i);
            if (turn != null && AgentMessage.ROLE_USER.equalsIgnoreCase(turn.role())
                    && StringUtils.hasText(turn.content())) {
                return turn.content().trim();
            }
        }
        return "";
    }

    /**
     * 这句话是不是"要写点什么"的意思。
     *
     * <p>两种信号满足其一就算：**动词**（建 / 改 / 删 / 安排…），或 **时间词 + 事件味**——
     * 后者是实测补上的：「明天下午三点和张总开会」这种最常见的说法里一个动词都没有，
     * 模型容易只回一段"我打算这样安排，确认吗"的文字，而用户根本没有可点的授权行。
     *
     * <p>仍然宁可漏、不多管闲事：纯闲聊（"你好"）不会命中任何一条。
     */
    private static boolean looksLikeWriteIntent(String text) {
        if (text.isEmpty()) {
            return false;
        }
        if (hasWriteVerb(text)) {
            return true;
        }
        for (String marker : EVENT_MARKERS) {
            if (text.contains(marker)) {
                return true;
            }
        }
        // 时间词 + 事情：例如「明天下午三点和张总开会」「周五中午和客户吃饭」
        String[] times = {
                "今天", "明天", "后天", "今晚", "今早", "上午", "下午", "晚上", "中午",
                "周一", "周二", "周三", "周四", "周五", "周六", "周日", "周天",
                "下周", "这周", "本月", "下个月", "次月", "点钟",
        };
        for (String time : times) {
            if (text.contains(time)) {
                return true;
            }
        }
        return text.matches(".*\\d{1,2}[点:：].*");
    }

    /**
     * 窄口径：只有**明确的写动词**才算。
     *
     * <p>用在"已经查过日程"之后：那一轮里时间词、"安排"这类词都可能只是查询的措辞
     * （「我明天有什么安排」），拿宽口径去判会把纯查询也推成写操作。
     */
    private static boolean hasWriteVerb(String text) {
        if (text.isEmpty()) {
            return false;
        }
        for (String marker : WRITE_VERBS) {
            if (text.contains(marker)) {
                return true;
            }
        }
        return false;
    }

    /** 明确的写动词。 */
    private static final String[] WRITE_VERBS = {
            "建", "创建", "新建", "加个", "加一", "记一下", "记录一下", "提醒我",
            "改", "改成", "改为", "调整", "推迟", "提前", "延长",
            "删", "删除", "取消", "去掉",
    };

    /** 事情本身的味道（"安排"既可能是查询也可能是写操作，所以只进宽口径）。 */
    private static final String[] EVENT_MARKERS = {
            "安排", "开会", "会议", "聚餐", "面试", "出差", "约会", "体检", "值班", "接机", "送机",
    };

    private static final String NUDGE = """
            系统提醒：用户这句话是要创建 / 修改 / 删除日程的意思，但你只回了一段文字，还没走到申请授权。
            （如果用户其实只是查询，忽略这条提醒，直接回答就好。）
            真要写就必须调用工具：需要 id 时先用 list_my_events 找到那条日程，
            找到之后**立刻**调用 create_my_event / update_my_event / delete_my_event 申请授权——
            不要用一句「确认一下？」代替授权请求。只回复文字的话，
            用户面前没有可点的授权行，这件事等于没发生。
            你刚才那段文字已经显示给用户了，**不要再重复它**，直接调工具。
            """;

    /**
     * SSE 的写出封装：同时承担"客户端断开"的判定。
     *
     * <p>连接没了还继续算下去只是白花钱，因此一旦发送失败就把状态标成已取消，
     * 让上层用 AgentStreamAborted 立刻停下来。
     */
    private static final class Stream {

        private final SseEmitter emitter;
        private final AgentApprovalRegistry approvals;
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        /** 这条流此刻在等哪一次授权（最多一个）：断线时要连这次等待一起收掉。 */
        private final AtomicReference<String> waitingActionId = new AtomicReference<>();
        /** 只由 completeQuietly 设置：早先让"发送失败"也置位它，导致异步请求永远不结束。 */
        private volatile boolean completed;

        private Stream(SseEmitter emitter, AgentApprovalRegistry approvals) {
            this.emitter = emitter;
            this.approvals = approvals;
        }

        /**
         * 客户端走了（断开 / 主动停止 / 流超时）。
         *
         * <p>除了标记取消，还要把**正挂着的那次授权**按拒绝收尾：不然这条流会一直躺在
         * 授权表里等满 90 秒才有人发现用户早就不在了。
         */
        void markClosed() {
            cancelled.set(true);
            String actionId = waitingActionId.getAndSet(null);
            if (actionId != null) {
                approvals.cancel(actionId);
            }
        }

        /** 记下这条流正在等哪一次授权。 */
        void awaitApproval(String actionId) {
            waitingActionId.set(actionId);
        }

        /** 答复（或超时）已经来了，这条流不再等谁了。 */
        void clearApproval() {
            waitingActionId.set(null);
        }

        /** 客户端是否已经走了（断开 / 主动停止）。 */
        boolean isCancelled() {
            return cancelled.get();
        }

        void delta(String text) {
            if (cancelled.get()) {
                throw new AgentStreamAborted("客户端已断开");
            }
            if (text == null || text.isEmpty()) {
                return;
            }
            send("delta", new DeltaEvent(text));
        }

        void status(String stage, String label) {
            send("status", new StatusEvent(stage, label));
        }

        void tool(String toolCallId, String name, String arguments, String result,
                  AgentToolRegistry.ToolRow row) {
            if (row == null) {
                return;
            }
            send("tool", new ToolEvent(toolCallId, name, arguments, result,
                    row.readOnly(), row.summary(), row.detail()));
        }

        void action(AgentAction action) {
            send("action", action);
        }

        void done(String finishReason, ModelUsage usage) {
            send("done", new DoneEvent(finishReason,
                    new UsagePayload(usage.promptTokens(), usage.completionTokens())));
            completeQuietly();
        }

        void error(int code, String message) {
            send("error", new ErrorEvent(code, message));
            completeQuietly();
        }

        void completeQuietly() {
            if (completed) {
                return;
            }
            completed = true;
            try {
                emitter.complete();
            } catch (Exception ignored) {
                // 连接早就断了：complete 再抛一次也没有意义
            }
        }

        private void send(String name, Object payload) {
            if (completed || cancelled.get()) {
                return;
            }
            synchronized (this) {
                if (completed || cancelled.get()) {
                    return;
                }
                try {
                    emitter.send(SseEmitter.event().name(name)
                            .data(payload, MediaType.APPLICATION_JSON));
                } catch (IOException | IllegalStateException ex) {
                    // 客户端走了（或异步请求已超时）：连挂着的授权一起收掉；
                    // 收尾仍由 done()/error() 负责
                    markClosed();
                }
            }
        }
    }
}
