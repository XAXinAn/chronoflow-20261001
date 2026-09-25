package com.xatodo.personal.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.personal.dto.PersonalDtos.CalendarCreateRequest;
import com.xatodo.personal.dto.PersonalDtos.CalendarResponse;
import com.xatodo.personal.dto.PersonalDtos.CalendarUpdateRequest;
import com.xatodo.personal.entity.Calendar;
import com.xatodo.personal.service.CalendarService;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 个人日历接口，对应 spec §6.2 的 `/calendars` 分组。
 */
@RestController
@RequestMapping("/api/v1/calendars")
@SecurityRequirement(name = "bearerAuth")
public class CalendarController {

    private final CalendarService calendarService;

    public CalendarController(CalendarService calendarService) {
        this.calendarService = calendarService;
    }

    @GetMapping
    public ApiResponse<List<CalendarResponse>> list() {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(calendarService.list(identityId).stream().map(CalendarController::toResponse).toList());
    }

    @PostMapping
    public ApiResponse<CalendarResponse> create(@Valid @RequestBody CalendarCreateRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(calendarService.create(identityId, request)));
    }

    @GetMapping("/{id}")
    public ApiResponse<CalendarResponse> get(@PathVariable Long id) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(calendarService.requireOwned(identityId, id)));
    }

    @PatchMapping("/{id}")
    public ApiResponse<CalendarResponse> update(@PathVariable Long id,
                                                @Valid @RequestBody CalendarUpdateRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(calendarService.update(identityId, id, request)));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        Long identityId = CurrentIdentity.require().identityId();
        calendarService.disable(identityId, id);
        return ApiResponse.ok();
    }

    private static CalendarResponse toResponse(Calendar calendar) {
        return new CalendarResponse(calendar.getId(), calendar.getCalendarType(), calendar.getName(),
                calendar.getColor(), calendar.getTimezone(), calendar.getIsDefault());
    }
}
