package com.xatodo.personal.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.personal.dto.PersonalDtos.TaskCompleteRequest;
import com.xatodo.personal.dto.PersonalDtos.TaskCreateRequest;
import com.xatodo.personal.dto.PersonalDtos.TaskResponse;
import com.xatodo.personal.dto.PersonalDtos.TaskUpdateRequest;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.dto.PersonalDtos.EventResponse;
import com.xatodo.personal.dto.PersonalDtos.TaskToEventRequest;
import com.xatodo.personal.service.ConversionService;
import com.xatodo.personal.service.TaskService;
import jakarta.validation.Valid;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 待办接口，对应 spec §6.2 的 `/tasks` 分组。
 */
@RestController
@RequestMapping("/api/v1/tasks")
@SecurityRequirement(name = "bearerAuth")
public class TaskController {

    private final TaskService taskService;
    private final ConversionService conversionService;

    public TaskController(TaskService taskService, ConversionService conversionService) {
        this.taskService = taskService;
        this.conversionService = conversionService;
    }

    /**
     * 待办转日程：需补齐起止时间；只给 at 时默认 1 小时。
     */
    @PostMapping("/{id}/convert-to-event")
    public ApiResponse<EventResponse> convertToEvent(@PathVariable Long id,
                                                     @RequestBody(required = false) TaskToEventRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        var event = conversionService.convertTaskToEvent(
                identityId, id,
                request == null ? null : request.at());
        return ApiResponse.ok(EventResponse.from(event));
    }

    @GetMapping
    public ApiResponse<List<TaskResponse>> list(@RequestParam(required = false) Long calendarId,
                                                @RequestParam(required = false) String status) {
        Long identityId = CurrentIdentity.require().identityId();
        var tasks = taskService.list(identityId, calendarId, status);
        // 关联日程的标题一次批量取出来：逐条查就是 N+1
        var titles = taskService.eventTitles(tasks.stream().map(Task::getEventId).toList());
        return ApiResponse.ok(tasks.stream()
                // 未关联日程时不要拿 null 去查表：不可变 Map 的 get(null) 会抛 NPE
                .map(task -> TaskResponse.from(
                        task,
                        task.getEventId() == null ? null : titles.get(task.getEventId()),
                        taskService.imageUrls(task)))
                .toList());
    }

    @PostMapping
    public ApiResponse<TaskResponse> create(@Valid @RequestBody TaskCreateRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(taskService.create(identityId, request)));
    }

    @GetMapping("/{id}")
    public ApiResponse<TaskResponse> get(@PathVariable Long id) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(taskService.requireOwned(identityId, id)));
    }

    @PatchMapping("/{id}")
    public ApiResponse<TaskResponse> update(@PathVariable Long id,
                                            @Valid @RequestBody TaskUpdateRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(taskService.update(identityId, id, request)));
    }

    @PostMapping("/{id}/complete")
    public ApiResponse<TaskResponse> complete(@PathVariable Long id,
                                              @Valid @RequestBody TaskCompleteRequest request) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(toResponse(taskService.complete(identityId, id, request)));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        Long identityId = CurrentIdentity.require().identityId();
        taskService.delete(identityId, id);
        return ApiResponse.ok();
    }

    private TaskResponse toResponse(Task task) {
        return TaskResponse.from(
                task, taskService.eventTitle(task.getEventId()), taskService.imageUrls(task));
    }
}
