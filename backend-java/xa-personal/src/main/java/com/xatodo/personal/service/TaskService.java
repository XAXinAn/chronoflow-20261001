package com.xatodo.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.PersonalDtos.TaskCompleteRequest;
import com.xatodo.personal.dto.PersonalDtos.TaskCreateRequest;
import com.xatodo.personal.dto.PersonalDtos.TaskUpdateRequest;
import com.xatodo.personal.entity.Calendar;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.mapper.TaskMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;

/**
 * 待办：与日程并列的第二个核心模型。支持一层子任务（spec §4.1.3）。
 */
@Service
public class TaskService {

    private static final Set<String> PRIORITIES = Set.of("LOW", "NORMAL", "HIGH", "URGENT");
    private static final Set<String> STATUSES =
            Set.of(Task.STATUS_TODO, Task.STATUS_DONE, Task.STATUS_CANCELLED);

    private final TaskMapper taskMapper;
    private final CalendarService calendarService;

    public TaskService(TaskMapper taskMapper, CalendarService calendarService) {
        this.taskMapper = taskMapper;
        this.calendarService = calendarService;
    }

    public List<Task> list(Long identityId, Long calendarId, String status) {
        LambdaQueryWrapper<Task> query = new LambdaQueryWrapper<Task>()
                .eq(Task::getOwnerIdentityId, identityId)
                .isNull(Task::getDeletedAt);
        if (calendarId != null) {
            calendarService.requireOwned(identityId, calendarId);
            query.eq(Task::getCalendarId, calendarId);
        }
        if (StringUtils.hasText(status)) {
            query.eq(Task::getStatus, status);
        }
        query.orderByAsc(Task::getSortOrder).orderByAsc(Task::getDueAt);
        return taskMapper.selectList(query);
    }

    @Transactional
    public Task create(Long identityId, TaskCreateRequest request) {
        Calendar calendar = request.calendarId() == null
                ? calendarService.defaultCalendar(identityId)
                : calendarService.requireOwned(identityId, request.calendarId());

        Task parent = null;
        if (request.parentTaskId() != null) {
            parent = requireOwned(identityId, request.parentTaskId());
            if (parent.getParentTaskId() != null) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "子任务不支持再嵌套子任务");
            }
            calendar = calendarService.requireOwned(identityId, parent.getCalendarId());
        }

        String priority = StringUtils.hasText(request.priority()) ? request.priority() : "NORMAL";
        if (!PRIORITIES.contains(priority)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "优先级取值非法: " + priority);
        }

        Task task = new Task();
        task.setCalendarId(calendar.getId());
        task.setOwnerIdentityId(identityId);
        task.setParentTaskId(parent == null ? null : parent.getId());
        task.setTitle(request.title());
        task.setDescription(request.description());
        task.setDueAt(request.dueAt());
        task.setAllDay(Boolean.TRUE.equals(request.allDay()));
        task.setStatus(Task.STATUS_TODO);
        task.setPriority(priority);
        task.setRrule(request.rrule());
        task.setSortOrder(0);
        taskMapper.insert(task);
        return task;
    }

    @Transactional
    public Task update(Long identityId, Long taskId, TaskUpdateRequest request) {
        Task task = requireOwned(identityId, taskId);
        if (StringUtils.hasText(request.title())) {
            task.setTitle(request.title());
        }
        if (request.description() != null) {
            task.setDescription(request.description());
        }
        // 先看「显式清空」再看赋值：否则一旦设过截止时间就再也回不到「待安排」
        if (Boolean.TRUE.equals(request.clearDueAt())) {
            task.setDueAt(null);
            task.setAllDay(false);
        } else if (request.dueAt() != null) {
            task.setDueAt(request.dueAt());
        }
        if (request.allDay() != null) {
            task.setAllDay(request.allDay());
        }
        if (StringUtils.hasText(request.priority())) {
            if (!PRIORITIES.contains(request.priority())) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "优先级取值非法: " + request.priority());
            }
            task.setPriority(request.priority());
        }
        if (StringUtils.hasText(request.status())) {
            if (!STATUSES.contains(request.status())) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "状态取值非法: " + request.status());
            }
            task.setStatus(request.status());
            task.setCompletedAt(Task.STATUS_DONE.equals(request.status())
                    ? OffsetDateTime.now(ZoneOffset.UTC)
                    : null);
        }
        if (request.sortOrder() != null) {
            task.setSortOrder(request.sortOrder());
        }
        taskMapper.updateById(task);
        return task;
    }

    @Transactional
    public Task complete(Long identityId, Long taskId, TaskCompleteRequest request) {
        Task task = requireOwned(identityId, taskId);
        boolean completed = Boolean.TRUE.equals(request.completed());
        task.setStatus(completed ? Task.STATUS_DONE : Task.STATUS_TODO);
        task.setCompletedAt(completed ? OffsetDateTime.now(ZoneOffset.UTC) : null);
        taskMapper.updateById(task);
        return task;
    }

    @Transactional
    public void delete(Long identityId, Long taskId) {
        Task task = requireOwned(identityId, taskId);
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        List<Task> children = taskMapper.selectList(new LambdaQueryWrapper<Task>()
                .eq(Task::getParentTaskId, task.getId())
                .isNull(Task::getDeletedAt));
        for (Task child : children) {
            child.setDeletedAt(now);
            taskMapper.updateById(child);
        }
        task.setDeletedAt(now);
        taskMapper.updateById(task);
    }

    public Task requireOwned(Long identityId, Long taskId) {
        Task task = taskMapper.selectById(taskId);
        if (task == null || task.getDeletedAt() != null || !identityId.equals(task.getOwnerIdentityId())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "待办不存在或不属于当前身份");
        }
        return task;
    }
}
