package com.chronoflow.agent.model;

/**
 * 语音转写结果（spec §11 阶段三）。
 *
 * @param language 识别出的语言；模型没给就是 null
 */
public record TranscriptionResult(String text, String language) {
}
