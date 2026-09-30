package com.xatodo.personal.dto;

import java.time.Instant;
import java.time.LocalDate;

/**
 * 日程实例。重复日程在查询范围内展开后的单次出现。
 *
 * @param occurrenceDate 该次出现的本地日期，用于定位重复例外；非重复日程为 null
 * @param modified       是否被例外单独修改过
 */
public record EventOccurrence(Long eventId,
                              Long calendarId,
                              String title,
                              String locationName,
                              String locationAddress,
                              String locationDetail,
                              Instant at,
                              String timezone,
                              boolean recurring,
                              LocalDate occurrenceDate,
                              boolean modified) {
}
