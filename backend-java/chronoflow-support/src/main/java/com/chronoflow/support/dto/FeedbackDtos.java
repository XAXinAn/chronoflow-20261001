package com.chronoflow.support.dto;

import com.chronoflow.support.entity.Feedback;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 意见反馈的请求与响应体（spec §4.1.9）。
 */
public final class FeedbackDtos {

    private FeedbackDtos() {
    }

    /** @param images 已上传图片的相对 URL 数组，可空 */
    public record FeedbackCreateRequest(String category, String content, List<String> images) {
    }

    /**
     * 用户侧与后台侧共用同一个响应结构。
     *
     * <p>用户端不展示处理过程（spec §4.1.9），所以它只用到 status；后台侧额外看 handledAt。
     */
    public record FeedbackResponse(Long id,
                                   String category,
                                   String content,
                                   List<String> images,
                                   String status,
                                   OffsetDateTime createdAt,
                                   OffsetDateTime handledAt) {

        public static FeedbackResponse from(Feedback feedback, List<String> images) {
            return new FeedbackResponse(
                    feedback.getId(), feedback.getCategory(), feedback.getContent(), images,
                    feedback.getStatus(), feedback.getCreatedAt(), feedback.getHandledAt());
        }
    }
}
