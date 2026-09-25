package com.xatodo.personal.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.personal.dto.ReminderDtos.ReminderResponse;
import com.xatodo.personal.dto.ReminderDtos.SetRemindersRequest;
import com.xatodo.personal.service.ReminderService;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

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
}
