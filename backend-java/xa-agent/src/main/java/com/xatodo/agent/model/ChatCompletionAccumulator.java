package com.xatodo.agent.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 把上游的流式增量帧拼成一次完整的回复。
 *
 * <p>单独成一个类是为了**可单测**：工具调用的参数是**分片**下发的
 * （`{"index":0,"function":{"arguments":"{\"ke"}}` 这样一段段来），
 * 拼错一个字段就是「工具名对、参数空」，界面表现为模型什么都查不到——
 * 这类 bug 不写测试根本发现不了，而它又完全可以离线验证。
 */
final class ChatCompletionAccumulator {

    private final StringBuilder text = new StringBuilder();
    /** 按 index 聚合：同一帧可能带多个工具调用，参数会跨帧追加。 */
    private final Map<Integer, PartialToolCall> toolCalls = new LinkedHashMap<>();
    private String finishReason;
    private ModelUsage usage = ModelUsage.UNKNOWN;

    /** 处理一帧 JSON；返回这帧里的正文增量（没有正文时是空串）。 */
    String accept(JsonNode chunk) {
        JsonNode usageNode = chunk.path("usage");
        if (usageNode.isObject() && !usageNode.isNull()) {
            usage = new ModelUsage(
                    usageNode.path("prompt_tokens").asLong(0),
                    usageNode.path("completion_tokens").asLong(0));
        }

        JsonNode choice = chunk.path("choices").path(0);
        if (choice.isMissingNode() || choice.isNull()) {
            // 只带 usage 的收尾帧：正文与工具调用都没有
            return "";
        }
        JsonNode finish = choice.path("finish_reason");
        if (finish.isTextual()) {
            finishReason = finish.asText();
        }

        JsonNode delta = choice.path("delta");
        String piece = delta.path("content").asText("");
        if (!piece.isEmpty()) {
            text.append(piece);
        }
        for (JsonNode call : delta.path("tool_calls")) {
            int index = call.path("index").asInt(0);
            PartialToolCall partial = toolCalls.computeIfAbsent(index, key -> new PartialToolCall());
            /**
             * id / name **只在非空时覆盖**。
             *
             * <p>这不是保守，而是实测：百炼后续每一帧都会带 `"id": ""`，
             * 无脑覆盖会把第一帧拿到的真实 id 冲掉，回灌工具结果时
             * `tool_call_id` 就对不上了（上游可能直接报错，也可能把结果丢进虚空）。
             */
            String id = call.path("id").asText("");
            if (!id.isBlank()) {
                partial.id = id;
            }
            JsonNode function = call.path("function");
            String name = function.path("name").asText("");
            if (!name.isBlank()) {
                partial.name = name;
            }
            if (function.path("arguments").isTextual()) {
                partial.arguments.append(function.path("arguments").asText());
            }
        }
        return piece;
    }

    CompletionResult result() {
        List<AgentToolCall> calls = new ArrayList<>();
        for (PartialToolCall partial : toolCalls.values()) {
            if (partial.name == null || partial.name.isBlank()) {
                continue;
            }
            calls.add(new AgentToolCall(
                    partial.id == null ? "call_" + calls.size() : partial.id,
                    partial.name,
                    partial.arguments.toString()));
        }
        return new CompletionResult(text.toString(), calls, finishReason, usage);
    }

    private static final class PartialToolCall {
        private String id;
        private String name;
        private final StringBuilder arguments = new StringBuilder();
    }
}
