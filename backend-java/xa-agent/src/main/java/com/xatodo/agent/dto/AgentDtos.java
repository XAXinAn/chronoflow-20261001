package com.xatodo.agent.dto;

import java.util.List;

/**
 * 助手接口的请求 / 响应形状（spec §11 阶段三）。
 *
 * <p>这些端点**不进 `contract/api-contract.json`**：那份清单的语义是「Java 与 Python 两版
 * 都必须实现」，而这一轮明确 Java 先行。口径写在 spec §6.2 与 AGENTS 的欠账清单里。
 */
public final class AgentDtos {

    private AgentDtos() {
    }

    /**
     * 客户端送回的一次工具调用（模型上一轮发起的）。
     *
     * <p>参照 mewcode 的 `conversation/Message`：历史里**助手消息要带 tool_use、紧跟一条
     * tool_result**，两个必须配对。少了工具调用，模型眼里自己那件事没落地，
     * 会把同一个动作再申请一遍（线上实测过：日程已经建好了，界面上却又冒出一条授权行）。
     */
    public record ToolCallTurn(String id, String name, String arguments) {
    }

    /**
     * 客户端送的一条对话。
     *
     * @param toolCalls  仅 assistant 用：这一轮请求调用了哪些工具
     * @param toolCallId 仅 tool 用：回应的是哪一个工具调用
     */
    public record ChatTurn(String role, String content, List<ToolCallTurn> toolCalls,
                           String toolCallId) {
    }

    /**
     * @param orgIdentityId 当前组织身份；为空表示这次只看个人日程（服务端会校验归属）
     */
    public record AgentChatRequest(List<ChatTurn> messages, Long orgIdentityId) {
    }

    /**
     * 用户对一次授权请求的答复（mewcode 的 {@code PermissionReply}）。
     *
     * <p>写工具在 agent 循环里**阻塞等待**这个答复：允许就真正执行并把结果写成 tool_result，
     * 拒绝也写一条「用户拒绝了、什么都没改」的 tool_result，然后模型在同一轮流里继续。
     *
     * @param feedback 拒绝时用户顺带说的话，原样交给模型（它可以据此换个做法）
     */
    public record ApprovalRequest(String actionId, Boolean allow, String feedback) {
    }

    public record StatusEvent(String stage, String label) {
    }

    public record DeltaEvent(String text) {
    }

    public record UsagePayload(long promptTokens, long completionTokens) {
    }

    public record DoneEvent(String finishReason, UsagePayload usage) {
    }

    /**
     * 一行**给用户看的**工具记录（spec §11 阶段三）：
     * 让"它到底做了什么"在对话里看得见，而不是只有一行瞬时的"正在查日程…"。
     *
     * @param summary 一句话摘要，例如「已查日程 · 3 条」
     * @param detail  点开后的人话明细（已由服务端生成，最多 3 条，不是原始 JSON）
     */
    public record ToolEvent(String toolCallId, String name, String arguments, String result,
                            boolean readOnly, String summary, List<String> detail) {
    }

    public record ErrorEvent(int code, String message) {
    }

    /** 语音转文字的结果；音频本身不落盘，转完即丢弃（spec §11 阶段三）。 */
    public record TranscriptionResponse(String text, String language) {
    }
}
