package com.xatodo.agent.service;

import com.xatodo.agent.config.AgentProperties;
import com.xatodo.agent.dto.AgentDtos.TranscriptionResponse;
import com.xatodo.agent.model.AgentModelClient;
import com.xatodo.agent.model.TranscriptionResult;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;

/**
 * 语音输入：录音 → 文字（spec §11 阶段三）。
 *
 * <p>与 {@link AgentChatService} 同一套分层：**控制器只做 HTTP，规则与错误语义都在这里**。
 * 这样「多大算太大」「没配置怎么答」这类决定只有一处，将来 Python 版对齐时照着抄也是抄这一份，
 * 而不是从控制器里把 `if` 一条条抠出来。
 *
 * <p>隐私边界：音频只在这次调用的内存里转 base64 转发给百炼，**不落盘、不进对象存储**——
 * 它只是把话变成字，存下来既没有用途，也平白多一份隐私负担。
 *
 * <p>转出来的文本由 App 填进输入框，**不自动发送**：语音识别会出错，让用户看一眼再发。
 */
@Service
public class AgentTranscribeService {

    /** 客户端没声明类型时的兜底：手机端录音就是 m4a（spec §6.2 `/ai/transcribe`）。 */
    private static final String DEFAULT_CONTENT_TYPE = "audio/mp4";

    private final AgentModelClient modelClient;
    private final AgentProperties properties;

    public AgentTranscribeService(AgentModelClient modelClient, AgentProperties properties) {
        this.modelClient = modelClient;
        this.properties = properties;
    }

    /** 转写是否可用；未配置时调用方必须走 90002 分支，而不是发起一次注定失败的请求。 */
    public boolean enabled() {
        return modelClient.transcriptionAvailable();
    }

    /**
     * 转写一段录音。
     *
     * <p>校验顺序是刻意的：**先看有没有文件，再看有没有接入**。反过来的话，
     * 「未配置 + 忘了带 file」会报成 90002，排查时会被引到模型配置上去。
     */
    public TranscriptionResponse transcribe(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "缺少上传文件");
        }
        if (!modelClient.transcriptionAvailable()) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "语音识别未配置");
        }
        if (file.getSize() > properties.getAsr().getMaxBytes()) {
            // 录音上限 60 秒，正常也就几百 KB；超了多半是传错了文件
            throw BizException.of(ErrorCode.PARAM_INVALID, "录音文件过大");
        }
        try {
            String contentType = StringUtils.hasText(file.getContentType())
                    ? file.getContentType()
                    : DEFAULT_CONTENT_TYPE;
            TranscriptionResult result = modelClient.transcribe(file.getBytes(), contentType);
            return new TranscriptionResponse(result.text(), result.language());
        } catch (IOException ex) {
            throw BizException.of(ErrorCode.INTERNAL_ERROR, "读取录音失败");
        }
    }
}
