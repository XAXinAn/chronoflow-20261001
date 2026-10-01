package com.chronoflow.support.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.common.validation.ImageUrls;
import com.chronoflow.support.dto.FeedbackDtos.FeedbackCreateRequest;
import com.chronoflow.support.dto.FeedbackDtos.FeedbackResponse;
import com.chronoflow.support.entity.Feedback;
import com.chronoflow.support.mapper.FeedbackMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 意见反馈（spec §4.1.9）。
 *
 * <p>用户侧只提交与查看自己的（按账号过滤）；后台侧由超管查阅与处理。
 */
@Service
public class FeedbackService {

    private static final Set<String> CATEGORIES = Set.of("BUG", "SUGGESTION", "OTHER");
    private static final Set<String> STATUSES =
            Set.of(Feedback.STATUS_OPEN, Feedback.STATUS_HANDLED);
    private static final int MAX_CONTENT_LENGTH = 2000;
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    private final FeedbackMapper feedbackMapper;
    private final ObjectMapper objectMapper;

    public FeedbackService(FeedbackMapper feedbackMapper, ObjectMapper objectMapper) {
        this.feedbackMapper = feedbackMapper;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public FeedbackResponse create(Long accountId, Long identityId, FeedbackCreateRequest request) {
        String content = request.content() == null ? "" : request.content().trim();
        if (content.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "反馈内容不能为空");
        }
        if (content.length() > MAX_CONTENT_LENGTH) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "反馈内容最长 " + MAX_CONTENT_LENGTH + " 个字符");
        }
        String category = request.category() == null
                ? "OTHER"
                : request.category().trim().toUpperCase(Locale.ROOT);
        if (!CATEGORIES.contains(category)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "反馈分类取值非法: " + request.category());
        }
        List<String> images = ImageUrls.requireValid(request.images());

        Feedback feedback = new Feedback();
        feedback.setAccountId(accountId);
        feedback.setIdentityId(identityId);
        feedback.setCategory(category);
        feedback.setContent(content);
        feedback.setImages(writeImages(images));
        feedback.setStatus(Feedback.STATUS_OPEN);
        feedbackMapper.insert(feedback);

        // 重新读回来再返回：created_at 等由数据库生成的列不在内存对象里，
        // 直接回内存对象会出现「响应里没有创建时间」这种假成功
        return toResponse(feedbackMapper.selectById(feedback.getId()));
    }

    /** 我提交过的反馈，按时间倒序（spec §4.1.9：用户端只查看自己的）。 */
    public List<FeedbackResponse> listMine(Long accountId, Integer limit) {
        List<Feedback> rows = feedbackMapper.selectList(new LambdaQueryWrapper<Feedback>()
                .eq(Feedback::getAccountId, accountId)
                .orderByDesc(Feedback::getCreatedAt)
                .last("LIMIT " + clampLimit(limit)));
        return rows.stream().map(this::toResponse).toList();
    }

    /** 超管视角：默认只看待处理的，可按分类筛选。 */
    public List<FeedbackResponse> listForAdmin(String status, String category, Integer limit) {
        String effectiveStatus = StringUtils.hasText(status)
                ? status.trim().toUpperCase(Locale.ROOT)
                : Feedback.STATUS_OPEN;
        if (!STATUSES.contains(effectiveStatus)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "status 取值非法: " + status);
        }
        LambdaQueryWrapper<Feedback> query = new LambdaQueryWrapper<Feedback>()
                .eq(Feedback::getStatus, effectiveStatus)
                .orderByDesc(Feedback::getCreatedAt)
                .last("LIMIT " + clampLimit(limit));
        if (StringUtils.hasText(category)) {
            String effectiveCategory = category.trim().toUpperCase(Locale.ROOT);
            if (!CATEGORIES.contains(effectiveCategory)) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "category 取值非法: " + category);
            }
            query.eq(Feedback::getCategory, effectiveCategory);
        }
        return feedbackMapper.selectList(query).stream().map(this::toResponse).toList();
    }

    @Transactional
    public FeedbackResponse handle(Long adminId, Long feedbackId) {
        Feedback feedback = feedbackMapper.selectById(feedbackId);
        if (feedback == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "反馈不存在");
        }
        if (Feedback.STATUS_HANDLED.equals(feedback.getStatus())) {
            // 幂等：重复点击「标记已处理」不该报错，也不该覆盖处理人
            return toResponse(feedback);
        }
        feedback.setStatus(Feedback.STATUS_HANDLED);
        feedback.setHandledAt(OffsetDateTime.now(ZoneOffset.UTC));
        feedback.setHandledByAdminId(adminId);
        feedbackMapper.updateById(feedback);
        return toResponse(feedbackMapper.selectById(feedbackId));
    }

    public FeedbackResponse toResponse(Feedback feedback) {
        return FeedbackResponse.from(feedback, readImages(feedback.getImages()));
    }

    private String writeImages(List<String> images) {
        try {
            return objectMapper.writeValueAsString(images);
        } catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
    }

    private List<String> readImages(String json) {
        if (!StringUtils.hasText(json)) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<List<String>>() {
            });
        } catch (IOException ex) {
            // 单条脏数据不该让整个列表接口 500
            return List.of();
        }
    }

    private static int clampLimit(Integer limit) {
        if (limit == null) {
            return DEFAULT_LIMIT;
        }
        return Math.clamp(limit, 1, MAX_LIMIT);
    }
}
