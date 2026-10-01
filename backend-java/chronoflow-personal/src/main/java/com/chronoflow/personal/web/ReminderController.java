package com.chronoflow.personal.web;

import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.personal.dto.ReminderDtos.ReminderResponse;
import com.chronoflow.personal.dto.ReminderDtos.ReminderScheduleEntry;
import com.chronoflow.personal.dto.ReminderDtos.SetRemindersRequest;
import com.chronoflow.personal.service.ReminderService;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 提醒设置，对应 spec §6.2 的 `/reminders`。
 */
@RestController
@RequestMapping("/api/v1/reminders")
@SecurityRequirement(name = "bearerAuth")
public class ReminderController {

    private final ReminderService reminderService;

    public ReminderController(ReminderService reminderService) {
        this.reminderService = reminderService;
    }

    @PutMapping
    public ApiResponse<List<ReminderResponse>> set(@Valid @RequestBody SetRemindersRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(reminderService.setReminders(identityId, request));
    }

    @GetMapping
    public ApiResponse<List<ReminderResponse>> list(@RequestParam String targetType,
                                                    @RequestParam Long targetId) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(reminderService.list(identityId, targetType, targetId));
    }

    /**
     * 未来一段时间内所有要响的提醒（含重复日程展开后的每一次实例）。
     *
     * <p>App 的到点提醒由**本地通知**完成（spec §4.5），换设备 / 重装 / 重新打开时
     * 需要把「这段时间该响什么」重新排一遍，这个接口就是那一次的输入。
     */
    @GetMapping("/schedule")
    public ApiResponse<List<ReminderScheduleEntry>> schedule(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime start,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime end) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(reminderService.upcoming(identityId, start.toInstant(), end.toInstant()));
    }
}
