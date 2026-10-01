package com.xatodo.agent.service;

/**
 * 「OCR 文字 → 日程草稿」里的一条（spec §4.1.9，`POST /ai/events/parse-text`）。
 *
 * <p>刻意比 {@code RecognizedEvent}（整图识别那一路）更窄：**只产出日程**，
 * 没有 `kind` 也没有 `confidence`——产品口径是「从通知里抽要你去做的事」，
 * 全都要落成用户的一条日程，不需要再分「日程 / 待办」。
 *
 * @param title        事项名（必填；没标题的条目在解析阶段就丢掉了）
 * @param at           时间点，**ISO-8601 字符串且带偏移量**（如 `2026-09-24T00:00:00+08:00`）；
 *                     **为 null / 字段缺失表示「没写日期」是合法结果**——不拿今天兜底，
 *                     由 App 的确认页让用户补。字符串而不是 OffsetDateTime：Jackson 会把
 *                     OffsetDateTime 归一成 UTC，客户端看到 `2026-09-24T16:00:00Z`，
 *                     再想判断「是不是当天 00:00（只说了哪天）」就得自己换算，不如直接给原时区
 * @param timezone     解释 `at` 的时区（固定回带请求时区），客户端靠它把时间落到正确的那一天
 * @param locationName 地点，可空
 * @param description  备注 / 登记路径 / 要交的材料，可空
 */
public record ParsedEventDraft(String title,
                               String at,
                               String timezone,
                               String locationName,
                               String description) {
}
