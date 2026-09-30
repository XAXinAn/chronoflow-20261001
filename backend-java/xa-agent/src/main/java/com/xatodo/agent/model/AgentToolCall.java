package com.xatodo.agent.model;

/**
 * 模型请求的一次工具调用。
 *
 * @param arguments 工具参数的 JSON 字符串（模型给的原样，解析失败按「参数非法」处理而不是崩掉整条流）
 */
public record AgentToolCall(String id, String name, String arguments) {
}
