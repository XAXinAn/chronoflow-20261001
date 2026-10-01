package com.chronoflow.personal.web;

import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.personal.ai.RecognizedEvent;
import com.chronoflow.personal.ai.VisionEventRecognizer;
import com.chronoflow.support.storage.ImageStorage;
import com.chronoflow.support.storage.StoredImage;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;

/**
 * 拍照 / 相册 → 日程草稿（spec §4.1.9）。
 *
 * <p>刻意**不自动落库**：识别结果只作为草稿返回，由用户在 App 里确认后才创建。
 * 模型会看错，直接写进日历比看错本身更糟——日历是用户唯一的事实来源。
 */
@RestController
@RequestMapping("/api/v1/ai/events")
@SecurityRequirement(name = "bearerAuth")
public class AiVisionController {

    private final VisionEventRecognizer recognizer;
    private final ImageStorage imageStorage;
    private final String timezone;

    public AiVisionController(VisionEventRecognizer recognizer,
                              ImageStorage imageStorage,
                              @Value("${chronoflow.ai.vision.timezone:Asia/Shanghai}") String timezone) {
        this.recognizer = recognizer;
        this.imageStorage = imageStorage;
        this.timezone = timezone;
    }

    @PostMapping(value = "/recognize", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<RecognizeResponse> recognize(
            @RequestParam(value = "file", required = false) MultipartFile file) {
        CurrentIdentity.require();
        if (file == null || file.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "缺少上传文件");
        }
        try {
            byte[] content = file.getBytes();
            // 复用上传通道：格式按文件头判定、按内容哈希落盘，识别结果里能带回这张图的 URL
            StoredImage stored = imageStorage.store(content);
            List<RecognizedEvent> items = recognizer.recognize(
                    content, stored.contentType(),
                    LocalDate.now(ZoneId.of(timezone)).toString(), timezone);
            return ApiResponse.ok(new RecognizeResponse(
                    recognizer.providerName(), stored.url(), items));
        } catch (IOException ex) {
            throw new UncheckedIOException("读取上传内容失败", ex);
        }
    }

    /**
     * @param provider 实际生效的识别实现（未接入时是 `unconfigured`，不过那种情况会直接报 90002）
     * @param imageUrl 已存下来的图片相对 URL
     * @param items    识别出的日程草稿，**可以为空**（图里确实没有日程，与「未接入」是两件事）
     */
    public record RecognizeResponse(String provider, String imageUrl, List<RecognizedEvent> items) {
    }
}
