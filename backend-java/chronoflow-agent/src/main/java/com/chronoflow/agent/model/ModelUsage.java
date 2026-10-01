package com.chronoflow.agent.model;

/**
 * 上游上报的 token 用量。
 *
 * <p>上游要开 `stream_options.include_usage=true` 才会在最后一帧带上它；
 * 拿不到时是 {@link #UNKNOWN}，日志里记 0 并注明未知，不假装统计到了。
 */
public record ModelUsage(long promptTokens, long completionTokens) {

    public static final ModelUsage UNKNOWN = new ModelUsage(0, 0);

    public long total() {
        return promptTokens + completionTokens;
    }
}
