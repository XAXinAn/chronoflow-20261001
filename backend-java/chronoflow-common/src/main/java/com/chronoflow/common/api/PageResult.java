package com.chronoflow.common.api;

import java.util.List;

/**
 * 统一分页返回，见 spec §6.1。
 */
public record PageResult<T>(long total, long page, long pageSize, List<T> list) {

    public static <T> PageResult<T> of(long total, long page, long pageSize, List<T> list) {
        return new PageResult<>(total, page, pageSize, list);
    }

    public static <T> PageResult<T> empty(long page, long pageSize) {
        return new PageResult<>(0, page, pageSize, List.of());
    }
}
