package com.chronoflow.support.web;

import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.support.storage.ImageStorage;
import com.chronoflow.support.storage.StoredImage;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.UncheckedIOException;

/**
 * 图片上传通道（spec §5.10）。头像与反馈图片共用它。
 */
@RestController
@RequestMapping("/api/v1/uploads")
@SecurityRequirement(name = "bearerAuth")
public class UploadController {

    private final ImageStorage imageStorage;

    public UploadController(ImageStorage imageStorage) {
        this.imageStorage = imageStorage;
    }

    /**
     * @param file multipart 字段名必须是 {@code file}（spec §5.10）
     */
    @PostMapping(value = "/images", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<UploadedImage> upload(@RequestParam(value = "file", required = false) MultipartFile file) {
        if (file == null || file.isEmpty()) {
            // 用 required=false 手动判空：交给框架的话，缺字段会变成一个没有 message 的 400
            throw BizException.of(ErrorCode.PARAM_MISSING, "缺少上传文件");
        }
        try {
            StoredImage stored = imageStorage.store(file.getBytes());
            return ApiResponse.ok(new UploadedImage(stored.url(), stored.size(), stored.contentType()));
        } catch (IOException ex) {
            throw new UncheckedIOException("读取上传内容失败", ex);
        }
    }

    /** @param url 相对 URL；客户端展示时拼当前 API 地址（spec §4.1.8） */
    public record UploadedImage(String url, long size, String contentType) {
    }
}
