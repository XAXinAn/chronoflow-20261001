package com.xatodo.agent.model;

/**
 * 客户端中途断开 / 用户点了「停止」。
 *
 * <p>用异常而不是返回值来表达，是因为它要**穿过**上游流式读取的循环立刻停下来：
 * 用户已经走了，继续花钱把答案读完没有任何意义。
 */
public class AgentStreamAborted extends RuntimeException {

    public AgentStreamAborted(String message) {
        super(message);
    }
}
