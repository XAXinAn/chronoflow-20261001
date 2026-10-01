package com.chronoflow.agent.model;

import java.util.List;

/**
 * 一次（可能是流式的）对话补全请求。
 *
 * @param jsonMode    要不要让上游按 JSON 对象约束输出（`response_format: {"type":"json_object"}`）。
 *                    对话/工具调用不需要；「OCR 文字 → 日程草稿」这类抽取任务需要，
 *                    否则模型时不时在 JSON 前后带一句话。默认 false，构造器保持两参不变。
 * @param temperature 采样温度；null 表示不指定（沿用上游默认）。抽取任务给 0，要的是稳定而不是想象力。
 */
public record CompletionRequest(List<AgentMessage> messages, List<AgentToolSpec> tools,
                                boolean jsonMode, Double temperature) {

    /** 对话 / 工具调用的常规请求：不约束 JSON、不指定温度。 */
    public CompletionRequest(List<AgentMessage> messages, List<AgentToolSpec> tools) {
        this(messages, tools, false, null);
    }

    /** 结构化抽取请求：JSON 模式 + 温度 0。 */
    public static CompletionRequest structured(List<AgentMessage> messages) {
        return new CompletionRequest(messages, List.of(), true, 0.0);
    }
}
