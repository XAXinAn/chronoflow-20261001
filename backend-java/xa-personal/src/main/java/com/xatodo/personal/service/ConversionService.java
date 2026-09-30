package com.xatodo.personal.service;

import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.entity.Calendar;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.mapper.EventMapper;
import com.xatodo.personal.mapper.TaskMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;

/**
 * 日程 ↔ 待办互转（spec §4.1.1）。
 *
 * <p>刻意独立成服务，避免 {@link EventService} 与 {@link TaskService} 互相注入形成循环依赖。
 * 两条转换都是「新建目标 + 把来源标记取消」，不做原地改类型——
 * 原地改类型会让挂在来源上的提醒等关联失效。
 */
@Service
public class ConversionService {

    private final EventService eventService;
    private final TaskService taskService;
    private final EventMapper eventMapper;
    private final TaskMapper taskMapper;
    private final CalendarService calendarService;

    public ConversionService(EventService eventService,
                             TaskService taskService,
                             EventMapper eventMapper,
                             TaskMapper taskMapper,
                             CalendarService calendarService) {
        this.eventService = eventService;
        this.taskService = taskService;
        this.eventMapper = eventMapper;
        this.taskMapper = taskMapper;
        this.calendarService = calendarService;
    }

    /**
     * 日程 → 待办：保留标题、描述与时间（转为 due_at），原日程标记取消。
     */
    @Transactional
    public Task convertEventToTask(Long identityId, Long eventId) {
        Event event = eventService.requireOwned(identityId, eventId);

        Task task = new Task();
        task.setCalendarId(event.getCalendarId());
        task.setOwnerIdentityId(identityId);
        task.setTitle(event.getTitle());
        task.setDescription(event.getDescription());
        task.setDueAt(event.getAt());
        task.setStatus(Task.STATUS_TODO);
        task.setPriority("NORMAL");
        task.setSortOrder(0);
        taskMapper.insert(task);

        event.setStatus(Event.STATUS_CANCELLED);
        eventMapper.updateById(event);
        return task;
    }

    /**
     * 待办 → 日程：未给时间时回退到待办的截止时间（日程与待办都只有一个时间，spec §4.1.2）。
     */
    @Transactional
    public Event convertTaskToEvent(Long identityId, Long taskId, OffsetDateTime at) {
        Task task = taskService.requireOwned(identityId, taskId);
        Calendar calendar = calendarService.requireOwned(identityId, task.getCalendarId());

        OffsetDateTime start = at != null ? at : task.getDueAt();
        if (start == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "该待办没有截止时间，请提供 at");
        }

        Event event = new Event();
        event.setCalendarId(calendar.getId());
        event.setCreatorIdentityId(identityId);
        event.setSourceType(Event.SOURCE_PERSONAL);
        event.setTitle(task.getTitle());
        event.setDescription(task.getDescription());
        event.setAt(start);
        event.setTimezone(calendar.getTimezone());
        event.setStatus(Event.STATUS_CONFIRMED);
        event.setUpdatedAfterDispatch(false);
        eventMapper.insert(event);

        task.setStatus(Task.STATUS_CANCELLED);
        taskMapper.updateById(task);
        return event;
    }
}
