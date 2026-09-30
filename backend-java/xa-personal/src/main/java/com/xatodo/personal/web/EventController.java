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
import com.xatodo.personal.service.ConversionService;
import com.xatodo.personal.service.TaskService;
import com.xatodo.personal.dto.PersonalDtos.TaskResponse;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
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
@SecurityRequirement(name = "bearerAuth")
public class EventController {

    private final EventService eventService;
    private final ConversionService conversionService;
    private final TaskService taskService;

    public EventController(EventService eventService,
                           ConversionService conversionService,
                           TaskService taskService) {
        this.eventService = eventService;
        this.conversionService = conversionService;
        this.taskService = taskService;
    }

    /**
     * 日程转待办：保留标题、描述与那一个时间点（转为 due_at），原日程标记取消。
     */
    @PostMapping("/{id}/convert-to-task")
    public ApiResponse<TaskResponse> convertToTask(@PathVariable Long id) {
        Long identityId = CurrentIdentity.require().identityId();
        var task = conversionService.convertEventToTask(identityId, id);
        return ApiResponse.ok(TaskResponse.from(
                task, taskService.eventTitle(task.getEventId()), taskService.imageUrls(task)));
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

    /**
     * 我的全部日程（每个重复序列只出现一次），按时间倒序，可用关键字过滤。
     *
     * <p>给「待办 → 关联日程」用（spec §4.1.6）：候选不该被时间窗口限制，而且要能搜。
     * 路径放在 `/{id}` 之前声明，避免 `/events/all` 被当成 id 解析。
     */
    @GetMapping("/all")
    public ApiResponse<List<EventOccurrence>> listAll(@RequestParam(required = false) String keyword,
                                                      @RequestParam(required = false) Integer limit) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(eventService.listAll(identityId, keyword, limit));
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
        return EventResponse.from(event);
    }
}
