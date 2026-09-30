package com.xatodo.agent.tool;

import java.time.Instant;
import java.time.LocalDate;

/**
 * 助手眼里的一条**个人**日程实例（重复日程已按实例展开）。
 *
 * @param recurring      是否属于重复序列——写操作会作用于**整条序列**，界面要标注出来
 * @param occurrenceDate 重复日程这一次出现的日期；非重复日程为 null
 */
public record VisibleEvent(long eventId,
                           String title,
                           Instant at,
                           String locationName,
                           String locationDetail,
                           String notePreview,
                           int noteLength,
                           boolean recurring,
                           LocalDate occurrenceDate) {
}
