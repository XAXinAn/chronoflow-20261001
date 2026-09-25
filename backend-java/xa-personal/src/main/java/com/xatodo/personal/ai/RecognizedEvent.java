package com.xatodo.personal.ai;

import java.time.OffsetDateTime;

/**
 * 识别出来的一条日程草稿（spec §4.1.9）。
 *
 * @param kind       模型判断它是 `EVENT`（日程）还是 `TASK`（待办）。
 *                   通知里两类事情经常混在一起（「假期 9/25–9/27」是日程，
 *                   「登记截止 9/24」是待办），靠「有没有时间」猜不如让模型直接说
 * @param startAt    识别出的开始时间；**为 null 表示没看出时间**——不要丢掉这条，
 *                   App 会把它降级成一条「待安排」的待办，让用户补
 * @param dueAt      待办的截止时间（`kind=TASK` 时用；「9月24日前」这类就落在这里）
 * @param description 备注/正文要点（通知里的地址、链接、要求都可以放）可为 null
 * @param confidence 0..1 的置信度，可为 null（模型没给就不编）
 */
public record RecognizedEvent(String title,
                              String kind,
                              OffsetDateTime startAt,
                              OffsetDateTime endAt,
                              OffsetDateTime dueAt,
                              Boolean allDay,
                              String locationName,
                              String description,
                              Double confidence) {
}
