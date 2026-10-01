package com.chronoflow.agent.web;

import com.chronoflow.agent.dto.AgentDtos.TranscriptionResponse;
import com.chronoflow.agent.service.AgentTranscribeService;
import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.common.api.ApiResponse;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * 语音输入：录音 → 文字（spec §11 阶段三）。
 *
 * <p>`POST /api/v1/ai/transcribe`，`multipart/form-data`，字段 `file`。
 * 与 {@link AgentChatController} 一样，这里**只做 HTTP**：大小上限、未配置怎么答、
 * 音频怎么交给模型，都在 {@link AgentTranscribeService} 里。
 */
@RestController
@RequestMapping("/api/v1/ai")
@SecurityRequirement(name = "bearerAuth")
public class AgentTranscribeController {

    private final AgentTranscribeService service;

    public AgentTranscribeController(AgentTranscribeService service) {
        this.service = service;
    }

    @PostMapping(value = "/transcribe", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<TranscriptionResponse> transcribe(
            @RequestParam(value = "file", required = false) MultipartFile file) {
        CurrentIdentity.require();
        return ApiResponse.ok(service.transcribe(file));
    }
}
