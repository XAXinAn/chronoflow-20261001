package com.xatodo.agent.dto;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * 一条**待用户确认**的写操作（spec §11 阶段三）。
 *
 * <p>模型永远没有直接写权限：服务端只把动作发给 App，由用户点确认后由 App 调既有 REST 接口。
 * 所以这里带着的是「要建 / 要删什么」的完整描述，而不是执行结果。
 *
 * @param actionId 客户端回传 actionResults 时用它对应
 * @param type     create_event / delete_event
 * @param summary  给用户看的一句话（App 的确认卡片直接用）
 * @param payload  执行所需的字段（App 用它拼 REST 请求体）
 */
public record AgentAction(String actionId, String type, String summary, ObjectNode payload) {

    public static final String TYPE_CREATE_EVENT = "create_event";
    public static final String TYPE_DELETE_EVENT = "delete_event";
    public static final String TYPE_UPDATE_EVENT = "update_event";
}
