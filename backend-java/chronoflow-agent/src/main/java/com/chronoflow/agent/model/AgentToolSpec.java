package com.chronoflow.agent.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * 工具声明（OpenAI function calling 的 `tools[].function`）。
 *
 * @param parameters JSON Schema 参数定义
 */
public record AgentToolSpec(String name, String description, JsonNode parameters) {
}
