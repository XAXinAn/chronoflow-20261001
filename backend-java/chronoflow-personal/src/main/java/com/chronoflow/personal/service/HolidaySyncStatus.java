package com.chronoflow.personal.service;

import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 节假日自动同步的运行状态（供 `/system/info` 上报）。
 *
 * <p>为什么要有它：后台任务最糟的失败方式就是**静默失败**——库里还是去年的数据，
 * 界面上什么也看不出来。把「最后一次成功是什么时候」暴露出来，故障才看得见。
 */
@Component
public class HolidaySyncStatus {

    private volatile Snapshot snapshot = new Snapshot(null, null, null, 0, List.of());

    public Snapshot snapshot() {
        return snapshot;
    }

    void recordSuccess(OffsetDateTime at, int days, List<Integer> years) {
        snapshot = new Snapshot(at, at, null, days, years);
    }

    void recordFailure(OffsetDateTime at, String error) {
        Snapshot current = snapshot;
        snapshot = new Snapshot(at, current.lastSuccessAt(), error, current.lastSyncedDays(), current.years());
    }

    /**
     * @param lastSuccessAt 最后一次成功同步的时间；从未成功过就是 null（这本身是个信号）
     * @param lastError     最近一次失败原因；成功后清空
     */
    public record Snapshot(OffsetDateTime lastRunAt,
                           OffsetDateTime lastSuccessAt,
                           String lastError,
                           int lastSyncedDays,
                           List<Integer> years) {
    }
}
