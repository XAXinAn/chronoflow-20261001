package com.xatodo.personal.dto;

import java.time.LocalDate;
import java.time.OffsetDateTime;

/**
 * 检索结果（spec §4.1.7 / §6.2 GET /search）。
 *
 * <p>日程与待办共用一个条目结构，靠 {@code type} 区分：App 拿到后是一份结果流，
 * 而不是两段需要各自排序、再拼起来的列表——排序规则（时间倒序、无时间置末）是跨类型的。
 */
public final class SearchDtos {

    public static final String TYPE_EVENT = "EVENT";
    public static final String TYPE_TASK = "TASK";

    private SearchDtos() {
    }

    /**
     * @param startAt        日程的开始时间；重复日程给出的是**最近一次实例**的时间
     * @param timezone       展示用时区。App 端一律显式带时区格式化，否则设备时区一变就与日历页自相矛盾
     * @param dueAt          待办的截止时间，可为空（「待安排」）
     * @param recurring      是否命中重复日程
     * @param occurrenceDate 命中重复实例的日期；非重复日程为 null。App 用它打开「这一次」而非整条序列
     */
    public record SearchResultItem(String type,
                                   Long id,
                                   String title,
                                   OffsetDateTime startAt,
                                   OffsetDateTime endAt,
                                   Boolean allDay,
                                   String timezone,
                                   String locationName,
                                   OffsetDateTime dueAt,
                                   String status,
                                   String priority,
                                   Boolean recurring,
                                   LocalDate occurrenceDate) {
    }
}
