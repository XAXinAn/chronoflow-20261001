package com.chronoflow.agent.model;

import java.util.function.Consumer;

/**
 * 模型接入点（spec §11 阶段三）。
 *
 * <p>抽成接口有两个目的：一是「换模型只换实现」（百炼 / 本地 vLLM / 以后的其它云），
 * 二是**测试可以注入假上游**——这里要验证的是我们这一侧的行为（工具循环、确认回路、
 * 事件序列、越权拦截），不是模型本身聪不聪明。
 */
public interface AgentModelClient {

    /** 当前实现的名字，用于日志与排错。 */
    String providerName();

    /** 是否已配置可用；未配置时调用方必须走 90002 分支，而不是发起一次注定失败的请求。 */
    boolean available();

    /** 语音转写是否可用。 */
    boolean transcriptionAvailable();

    /**
     * 流式补全。
     *
     * @param onTextDelta 每收到一段正文就回调一次（实现方负责把增量转成 SSE 事件）；
     *                    回调抛 {@link AgentStreamAborted} 时应立刻停止读取并向上抛
     * @return 累积结果（正文 + 工具调用 + 用量）
     */
    CompletionResult complete(CompletionRequest request, Consumer<String> onTextDelta);

    /**
     * 语音转文字。
     *
     * <p>音频只在这条调用链的内存里存在，不进对象存储、不落盘（spec §11）。
     */
    TranscriptionResult transcribe(byte[] audio, String contentType);
}
