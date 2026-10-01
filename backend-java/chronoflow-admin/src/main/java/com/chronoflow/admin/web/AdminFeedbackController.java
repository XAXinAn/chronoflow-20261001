package com.chronoflow.admin.web;

import com.chronoflow.admin.security.CurrentAdmin;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.support.dto.FeedbackDtos.FeedbackResponse;
import com.chronoflow.support.service.FeedbackService;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 意见反馈的后台查阅与处理（spec §4.1.9 / §6.3）。仅平台超管。
 */
@RestController
@RequestMapping("/api/v1/admin/feedback")
@SecurityRequirement(name = "bearerAuth")
public class AdminFeedbackController {

    private final FeedbackService feedbackService;

    public AdminFeedbackController(FeedbackService feedbackService) {
        this.feedbackService = feedbackService;
    }

    /** @param status 省略时只看待处理的（超管日常的工作面） */
    @GetMapping
    public ApiResponse<List<FeedbackResponse>> list(@RequestParam(required = false) String status,
                                                    @RequestParam(required = false) String category,
                                                    @RequestParam(required = false) Integer limit) {
        CurrentAdmin.requireSuperAdmin();
        return ApiResponse.ok(feedbackService.listForAdmin(status, category, limit));
    }

    @PostMapping("/{id}/handle")
    public ApiResponse<FeedbackResponse> handle(@PathVariable Long id) {
        return ApiResponse.ok(feedbackService.handle(CurrentAdmin.requireSuperAdmin().adminId(), id));
    }
}
