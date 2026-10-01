package com.chronoflow.agent.model;

import java.util.List;

/**
 * 一次补全的结果。
 *
 * @param text         已流式吐给客户端的正文（再拼一份，便于记日志与排错）
 * @param toolCalls    模型这一轮想调用的工具；为空表示这轮就是最终答复
 * @param finishReason stop / tool_calls / length ...
 */
public record CompletionResult(String text, List<AgentToolCall> toolCalls, String finishReason,
                               ModelUsage usage) {
}
