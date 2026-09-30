package com.xatodo.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.common.validation.ImageUrls;
import com.xatodo.personal.dto.PersonalDtos.TaskCompleteRequest;
import com.xatodo.personal.dto.PersonalDtos.TaskCreateRequest;
import com.xatodo.personal.dto.PersonalDtos.TaskUpdateRequest;
import com.xatodo.personal.entity.Calendar;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.mapper.EventMapper;
import com.xatodo.personal.mapper.TaskMapper;
import com.xatodo.personal.recurrence.RecurrenceExpander;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

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
    private final EventMapper eventMapper;
    private final ObjectMapper objectMapper;
    private final RecurrenceExpander recurrenceExpander;

    public TaskService(TaskMapper taskMapper,
                       CalendarService calendarService,
                       EventMapper eventMapper,
                       ObjectMapper objectMapper,
                       RecurrenceExpander recurrenceExpander) {
        this.taskMapper = taskMapper;
        this.calendarService = calendarService;
        this.eventMapper = eventMapper;
        this.objectMapper = objectMapper;
        this.recurrenceExpander = recurrenceExpander;
    }

    /**
     * 校验并归一 RRULE：空白一律存 null（不重复）。
     *
     * <p>待办此前只在创建时写 rrule、且从不校验，编辑也无入口；现在两头的语义要和日程一致，
     * 否则「规则写错了却存进去了」会在展开时才炸，排查起来只能靠日志。
     */
    private String normalizeRrule(String rrule) {
        if (!StringUtils.hasText(rrule)) {
            return null;
        }
        recurrenceExpander.validate(rrule);
        return rrule;
    }

    /** 待办的图片附件（jsonb → 列表）。脏数据不该让整个列表接口 500。 */
    public List<String> imageUrls(Task task) {
        if (task == null || !StringUtils.hasText(task.getImages())) {
            return List.of();
        }
        try {
            return objectMapper.readValue(task.getImages(), new TypeReference<List<String>>() {
            });
        } catch (Exception ex) {
            return List.of();
        }
    }

    private String writeImages(List<String> images) {
        try {
            return objectMapper.writeValueAsString(ImageUrls.requireValid(images));
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException(ex);
        }
    }

    /**
     * 批量取关联日程的标题，供列表展示。
     *
     * <p>之所以要一次批量取：列表里几十条待办如果逐条查日程，就是典型的 N+1。
     */
    public Map<Long, String> eventTitles(Collection<Long> eventIds) {
        List<Long> ids = eventIds.stream().filter(Objects::nonNull).distinct().toList();
        if (ids.isEmpty()) {
            // 用 Collections.emptyMap 而不是 Map.of()：后者是不可变集合，
            // get(null) 会直接抛 NPE——未关联日程的待办正好会走到这里。
            return java.util.Collections.emptyMap();
        }
        return eventMapper.selectBatchIds(ids).stream()
                .filter(event -> event.getDeletedAt() == null)
                .collect(Collectors.toMap(Event::getId, Event::getTitle));
    }

    /**
     * 单条待办的关联日程标题。
     *
     * <p>不能直接写 {@code List.of(task.getEventId())}：{@code List.of} 不接受 null 元素，
     * 未关联日程的待办会直接 NPE——这是「默认路径也要能跑」的典型翻车点。
     */
    public String eventTitle(Long eventId) {
        if (eventId == null) {
            return null;
        }
        return eventTitles(List.of(eventId)).get(eventId);
    }

    /** 关联的日程必须是当前身份自己的，不能挂到别人的日程上（spec §4.1.6）。 */
    private void requireOwnedEvent(Long identityId, Long eventId) {
        Event event = eventMapper.selectById(eventId);
        if (event == null || event.getDeletedAt() != null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "关联的日程不存在");
        }
        calendarService.requireOwned(identityId, event.getCalendarId());
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
        if (request.eventId() != null) {
            requireOwnedEvent(identityId, request.eventId());
        }
        task.setEventId(request.eventId());
        task.setTitle(request.title());
        task.setDescription(request.description());
        task.setDueAt(request.dueAt());
        task.setStatus(Task.STATUS_TODO);
        task.setPriority(priority);
        task.setImages(writeImages(request.images()));
        task.setRrule(normalizeRrule(request.rrule()));
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
        // 先看「显式解绑」再看改绑：null 在 PATCH 里是「不修改」，解绑必须靠 clearEvent
        if (Boolean.TRUE.equals(request.clearEvent())) {
            task.setEventId(null);
        } else if (request.eventId() != null) {
            requireOwnedEvent(identityId, request.eventId());
            task.setEventId(request.eventId());
        }
        // 先看「显式清空」再看赋值：否则一旦设过截止时间就再也回不到「待安排」
        if (Boolean.TRUE.equals(request.clearDueAt())) {
            task.setDueAt(null);
        } else if (request.dueAt() != null) {
            task.setDueAt(request.dueAt());
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
        // 图片：null = 不修改（与其它字段一致）；传空数组才是「删光所有图片」
        if (request.images() != null) {
            task.setImages(writeImages(request.images()));
        }
        // 重复规则与日程同一套语义：null = 不修改，空串 = 清空（spec §4.1.2）
        if (request.rrule() != null) {
            task.setRrule(normalizeRrule(request.rrule()));
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
