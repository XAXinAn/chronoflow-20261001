package com.xatodo.personal.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;

import java.time.LocalDate;
import java.util.List;

public final class ReminderDtos {

    private ReminderDtos() {
    }

    public record ReminderItem(
            @NotNull(message = "minutesBefore 不能为空")
            @PositiveOrZero(message = "提前量不能为负") Integer minutesBefore,
            LocalDate occurrenceDate) {
    }

    /**
     * 批量覆盖某个日程 / 待办的提醒设置。传空列表即清空全部提醒。
     */
    public record SetRemindersRequest(
            @NotBlank(message = "targetType 不能为空") String targetType,
            @NotNull(message = "targetId 不能为空") Long targetId,
            // 允许空数组：语义是「清空全部提醒」
            @NotNull(message = "items 不能为空，如需清空请传空数组") @Valid List<ReminderItem> items) {
    }

    public record ReminderResponse(Long id,
                                   String targetType,
                                   Long targetId,
                                   Integer minutesBefore,
                                   LocalDate occurrenceDate,
                                   String channel,
                                   Boolean enabled) {
    }

    /**
     * 未来提醒的一条排期（`GET /reminders/schedule`）。
     *
     * <p>App 的到点提醒走**本地通知**（spec §4.5），所以它需要知道「未来这段时间里，
     * 哪些日程/待办要在什么时刻响几声」——重复日程必须按**展开后的每一次实例**给，
     * 否则「每周五交周报」在客户端只排得到第一次。
     *
     * <p>业务对象的时间信息一并返回（标题 / 地点 / 时间点 / 时区），
     * 这样 App 一次请求就能把通知排完，不必再逐条去查日程详情。
     */
    public record ReminderScheduleEntry(String targetType,
                                        Long targetId,
                                        /** 重复日程的该次出现日期；非重复日程为 null */
                                        LocalDate occurrenceDate,
                                        String title,
                                        String locationName,
                                        java.time.Instant at,
                                        String timezone,
                                        java.util.List<Integer> minutesBefore) {
    }
}
