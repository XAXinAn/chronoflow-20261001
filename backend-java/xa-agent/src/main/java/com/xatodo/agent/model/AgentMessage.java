package com.xatodo.agent.model;

import java.util.List;

/**
 * 送给模型的一条消息（OpenAI 兼容形状）。
 *
 * <p>角色只有四种：`system`（系统提示）、`user`（用户）、`assistant`（模型回复，
 * 可能带工具调用）、`tool`（工具执行结果，必须带 {@code toolCallId}）。
 *
 * @param toolCalls  仅 assistant 用：这一轮模型请求调用的工具
 * @param toolCallId 仅 tool 用：回应的是哪一个工具调用
 */
public record AgentMessage(String role, String content, List<AgentToolCall> toolCalls, String toolCallId) {

    public static final String ROLE_SYSTEM = "system";
    public static final String ROLE_USER = "user";
    public static final String ROLE_ASSISTANT = "assistant";
    public static final String ROLE_TOOL = "tool";

    public static AgentMessage system(String content) {
        return new AgentMessage(ROLE_SYSTEM, content, List.of(), null);
    }

    public static AgentMessage user(String content) {
        return new AgentMessage(ROLE_USER, content, List.of(), null);
    }

    public static AgentMessage assistant(String content, List<AgentToolCall> toolCalls) {
        return new AgentMessage(ROLE_ASSISTANT, content, List.copyOf(toolCalls), null);
    }

    public static AgentMessage tool(String toolCallId, String content) {
        return new AgentMessage(ROLE_TOOL, content, List.of(), toolCallId);
    }
}
