package com.xatodo.agent.model;

import java.util.List;

/** 一次（可能是流式的）对话补全请求。 */
public record CompletionRequest(List<AgentMessage> messages, List<AgentToolSpec> tools) {
}
