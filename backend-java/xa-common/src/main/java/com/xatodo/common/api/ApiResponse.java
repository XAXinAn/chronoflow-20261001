package com.xatodo.common.api;

import com.xatodo.common.web.TraceIds;

/**
 * 统一响应体：{@code {code, message, data, traceId}}，见 spec §6.1。
 */
public record ApiResponse<T>(int code, String message, T data, String traceId) {

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(ErrorCode.SUCCESS.getCode(), ErrorCode.SUCCESS.getMessage(), data, TraceIds.current());
    }

    public static ApiResponse<Void> ok() {
        return ok(null);
    }

    public static <T> ApiResponse<T> failure(ErrorCode errorCode) {
        return failure(errorCode.getCode(), errorCode.getMessage());
    }

    public static <T> ApiResponse<T> failure(ErrorCode errorCode, String message) {
        return failure(errorCode.getCode(), message);
    }

    public static <T> ApiResponse<T> failure(int code, String message) {
        return new ApiResponse<>(code, message, null, TraceIds.current());
    }
}
