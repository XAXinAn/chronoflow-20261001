package com.chronoflow.common.web;

import org.slf4j.MDC;

import java.util.UUID;

/**
 * traceId 上下文，随响应体与日志贯穿全链路（spec §7.4）。
 */
public final class TraceIds {

    public static final String MDC_KEY = "traceId";
    public static final String HEADER = "X-Trace-Id";

    private TraceIds() {
    }

    public static String generate() {
        return UUID.randomUUID().toString();
    }

    public static void set(String traceId) {
        MDC.put(MDC_KEY, traceId);
    }

    public static String current() {
        return MDC.get(MDC_KEY);
    }

    public static void clear() {
        MDC.remove(MDC_KEY);
    }
}
