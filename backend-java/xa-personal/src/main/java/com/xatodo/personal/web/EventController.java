package com.xatodo.personal.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.personal.dto.EventOccurrence;
import com.xatodo.personal.dto.PersonalDtos.EventCreateRequest;
import com.xatodo.personal.dto.PersonalDtos.EventResponse;
import com.xatodo.personal.dto.PersonalDtos.EventScope;
import com.xatodo.personal.dto.PersonalDtos.EventUpdateRequest;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.service.EventService;
import jakarta.validation.Valid;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;

/**
 * 日程接口，对应 spec §6.2 的 `/events` 分组。
 */
@RestController
@RequestMapping("/api/v1/events")
public class EventController {

    private final EventService eventService;

    public EventController(EventService eventService) {
        this.eventService = eventService;
    }

    /**
     * 日历视图范围查询，返回展开后的日程实例（含重复日程的每一次出现）。
     */
    @GetMapping
    public ApiResponse<List<EventOccurrence>> range(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime start,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime end,
            @RequestParam(required = false) List<Long> calendarIds) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(eventService.rangeQuery(
                identityId, calendarIds, start.toInstant(), end.toInstant()));
    }

    @PostMapping
    public ApiResponse<EventResponse> create(@Valid @RequestBody EventCreateRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(eventService.create(identityId, request)));
    }

    @GetMapping("/{id}")
    public ApiResponse<EventResponse> get(@PathVariable Long id) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(eventService.get(identityId, id)));
    }

    @PatchMapping("/{id}")
    public ApiResponse<EventResponse> update(@PathVariable Long id,
                                             @Valid @RequestBody EventUpdateRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(eventService.update(identityId, id, request)));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id,
                                    @RequestParam(required = false) EventScope scope,
                                    @RequestParam(required = false)
                                    @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate occurrenceDate) {
        Long identityId = CurrentIdentity.require().identityId();
        eventService.delete(identityId, id, scope, occurrenceDate);
        return ApiResponse.ok();
    }

    private static EventResponse toResponse(Event event) {
        return new EventResponse(event.getId(), event.getCalendarId(), event.getTitle(),
                event.getDescription(), event.getLocation(), event.getStartAt(), event.getEndAt(),
                event.getAllDay(), event.getTimezone(), event.getRrule(), event.getStatus());
    }
}
