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
}
