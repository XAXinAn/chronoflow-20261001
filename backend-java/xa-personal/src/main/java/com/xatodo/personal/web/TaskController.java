package com.xatodo.personal.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.personal.dto.PersonalDtos.TaskCompleteRequest;
import com.xatodo.personal.dto.PersonalDtos.TaskCreateRequest;
import com.xatodo.personal.dto.PersonalDtos.TaskResponse;
import com.xatodo.personal.dto.PersonalDtos.TaskUpdateRequest;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.service.TaskService;
import jakarta.validation.Valid;
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
public class TaskController {

    private final TaskService taskService;

    public TaskController(TaskService taskService) {
        this.taskService = taskService;
    }

    @GetMapping
    public ApiResponse<List<TaskResponse>> list(@RequestParam(required = false) Long calendarId,
                                                @RequestParam(required = false) String status) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(taskService.list(identityId, calendarId, status).stream()
                .map(TaskController::toResponse).toList());
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

    private static TaskResponse toResponse(Task task) {
        return new TaskResponse(task.getId(), task.getCalendarId(), task.getParentTaskId(),
                task.getTitle(), task.getDescription(), task.getDueAt(), task.getAllDay(),
                task.getStatus(), task.getCompletedAt(), task.getPriority(), task.getSortOrder());
    }
}
