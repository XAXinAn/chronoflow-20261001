package com.chronoflow.support.web;

import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.support.dto.FeedbackDtos.FeedbackCreateRequest;
import com.chronoflow.support.dto.FeedbackDtos.FeedbackResponse;
import com.chronoflow.support.service.FeedbackService;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 意见反馈（spec §4.1.9）。用户侧只有提交与查看自己的历史，处理过程不在 App 展示。
 */
@RestController
@RequestMapping("/api/v1/feedback")
@SecurityRequirement(name = "bearerAuth")
public class FeedbackController {

    private final FeedbackService feedbackService;

    public FeedbackController(FeedbackService feedbackService) {
        this.feedbackService = feedbackService;
    }

    @PostMapping
    public ApiResponse<FeedbackResponse> submit(@RequestBody FeedbackCreateRequest request) {
        var principal = CurrentIdentity.require();
        return ApiResponse.ok(feedbackService.create(
                principal.accountId(), principal.identityId(), request));
    }

    @GetMapping
    public ApiResponse<List<FeedbackResponse>> mine(@RequestParam(required = false) Integer limit) {
        return ApiResponse.ok(feedbackService.listMine(CurrentIdentity.require().accountId(), limit));
    }
}
