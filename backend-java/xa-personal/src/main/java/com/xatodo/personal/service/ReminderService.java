package com.xatodo.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.EventOccurrence;
import com.xatodo.personal.dto.ReminderDtos.ReminderItem;
import com.xatodo.personal.dto.ReminderDtos.ReminderResponse;
import com.xatodo.personal.dto.ReminderDtos.ReminderScheduleEntry;
import com.xatodo.personal.dto.ReminderDtos.SetRemindersRequest;
import com.xatodo.personal.entity.Calendar;
import com.xatodo.personal.entity.Reminder;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.mapper.ReminderMapper;
import com.xatodo.personal.mapper.TaskMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 日程 / 待办的提醒设置。
 *
 * <p>{@code PUT} 语义是**整体覆盖**：先清空该目标下当前身份的全部提醒再写入，
 * 避免客户端需要自己算增删差异（spec §6.2 的 `PUT /reminders`）。
 */
@Service
public class ReminderService {

    private static final Set<String> TARGET_TYPES =
            Set.of(Reminder.TARGET_EVENT, Reminder.TARGET_TASK);

    /** 待办自己没有时区列，取所在日历的时区；没有就按第一版的默认时区（spec §7.3）。 */
    private static final String DEFAULT_TIMEZONE = "Asia/Shanghai";

    private final ReminderMapper reminderMapper;
    private final EventService eventService;
    private final TaskService taskService;
    private final TaskMapper taskMapper;
    private final CalendarService calendarService;

    public ReminderService(ReminderMapper reminderMapper,
                           EventService eventService,
                           TaskService taskService,
                           TaskMapper taskMapper,
                           CalendarService calendarService) {
        this.reminderMapper = reminderMapper;
        this.eventService = eventService;
        this.taskService = taskService;
        this.taskMapper = taskMapper;
        this.calendarService = calendarService;
    }

    @Transactional
    public List<ReminderResponse> setReminders(Long identityId, SetRemindersRequest request) {
        requireOwnership(identityId, request.targetType(), request.targetId());

        reminderMapper.delete(new LambdaQueryWrapper<Reminder>()
                .eq(Reminder::getTargetType, request.targetType())
                .eq(Reminder::getTargetId, request.targetId())
                .eq(Reminder::getIdentityId, identityId));

        for (ReminderItem item : request.items()) {
            Reminder reminder = new Reminder();
            reminder.setTargetType(request.targetType());
            reminder.setTargetId(request.targetId());
            reminder.setIdentityId(identityId);
            reminder.setOccurrenceDate(item.occurrenceDate());
            reminder.setMinutesBefore(item.minutesBefore());
            reminder.setChannel(Reminder.CHANNEL_PUSH);
            reminder.setEnabled(true);
            reminderMapper.insert(reminder);
        }
        return list(identityId, request.targetType(), request.targetId());
    }

    public List<ReminderResponse> list(Long identityId, String targetType, Long targetId) {
        requireOwnership(identityId, targetType, targetId);
        return reminderMapper.selectList(new LambdaQueryWrapper<Reminder>()
                        .eq(Reminder::getTargetType, targetType)
                        .eq(Reminder::getTargetId, targetId)
                        .eq(Reminder::getIdentityId, identityId)
                        .orderByAsc(Reminder::getMinutesBefore))
                .stream()
                .map(reminder -> new ReminderResponse(
                        reminder.getId(), reminder.getTargetType(), reminder.getTargetId(),
                        reminder.getMinutesBefore(), reminder.getOccurrenceDate(),
                        reminder.getChannel(), reminder.getEnabled()))
                .toList();
    }

    /**
     * 未来一段时间内所有要响的提醒（App 启动 / 回到前台时重排本地通知用，spec §4.5）。
     *
     * <p>重复日程按**展开后的每一次实例**给出：客户端只拿得到 RRULE 字符串，
     * 自己展开等于把 lib-recur 再实现一遍，而且两版展开规则一旦不一致，
     * 「某条重复日程在这台手机上不响」这种问题几乎无法排查。展开由服务端做一次。
     */
    public List<ReminderScheduleEntry> upcoming(Long identityId, Instant rangeStart, Instant rangeEnd) {
        if (!rangeStart.isBefore(rangeEnd)) {
            // 与 Python 版一致用 30001（时间非法），而不是 /events 那边的 10002：
            // 这是新端点，两版必须同码；老端点的既有分歧不在本次改动里顺手改，避免踩到别的用例
            throw BizException.of(ErrorCode.EVENT_TIME_INVALID, "结束时间必须晚于开始时间");
        }
        List<Reminder> reminders = reminderMapper.selectList(new LambdaQueryWrapper<Reminder>()
                .eq(Reminder::getIdentityId, identityId)
                .eq(Reminder::getEnabled, true));
        if (reminders.isEmpty()) {
            return List.of();
        }

        Map<String, Map<Long, List<Integer>>> byTarget = reminders.stream()
                .collect(Collectors.groupingBy(Reminder::getTargetType,
                        Collectors.groupingBy(Reminder::getTargetId,
                                Collectors.mapping(Reminder::getMinutesBefore, Collectors.toList()))));

        List<ReminderScheduleEntry> entries = new ArrayList<>();
        Map<Long, List<Integer>> eventReminders =
                byTarget.getOrDefault(Reminder.TARGET_EVENT, Map.of());
        if (!eventReminders.isEmpty()) {
            for (EventOccurrence occurrence
                    : eventService.rangeQuery(identityId, null, rangeStart, rangeEnd)) {
                List<Integer> minutes = eventReminders.get(occurrence.eventId());
                if (minutes == null) {
                    continue;
                }
                entries.add(new ReminderScheduleEntry(
                        Reminder.TARGET_EVENT,
                        occurrence.eventId(),
                        occurrence.occurrenceDate(),
                        occurrence.title(),
                        occurrence.locationName(),
                        occurrence.at(),
                        occurrence.timezone(),
                        sortedMinutes(minutes)));
            }
        }

        Map<Long, List<Integer>> taskReminders = byTarget.getOrDefault(Reminder.TARGET_TASK, Map.of());
        if (!taskReminders.isEmpty()) {
            entries.addAll(taskEntries(identityId, rangeStart, rangeEnd, taskReminders));
        }

        entries.sort(Comparator.comparing(ReminderScheduleEntry::at)
                .thenComparing(ReminderScheduleEntry::targetType)
                .thenComparing(ReminderScheduleEntry::targetId));
        return entries;
    }

    /**
     * 待办的排期。
     *
     * <p>只取「待办中（TODO）且有截止时间」的：已完成 / 已取消的待办再到点提醒一次，
     * 只会让用户觉得提醒不准（与列表里不展示它们是一个口径）。
     *
     * <p>时区取待办所在日历的时区 —— 待办自己没有时区列，而「只说了哪一天」的提醒基准（当地 09:00）
     * 需要一个时区才算得对。
     */
    private List<ReminderScheduleEntry> taskEntries(Long identityId,
                                                    Instant rangeStart,
                                                    Instant rangeEnd,
                                                    Map<Long, List<Integer>> taskReminders) {
        List<Task> tasks = taskMapper.selectList(new LambdaQueryWrapper<Task>()
                .eq(Task::getOwnerIdentityId, identityId)
                .eq(Task::getStatus, Task.STATUS_TODO)
                .isNull(Task::getDeletedAt)
                .in(Task::getId, taskReminders.keySet())
                .gt(Task::getDueAt, OffsetDateTime.ofInstant(rangeStart, ZoneOffset.UTC))
                .le(Task::getDueAt, OffsetDateTime.ofInstant(rangeEnd, ZoneOffset.UTC)));
        if (tasks.isEmpty()) {
            return List.of();
        }
        Map<Long, String> zones = calendarService.list(identityId).stream()
                .collect(Collectors.toMap(Calendar::getId,
                        calendar -> calendar.getTimezone() == null
                                ? DEFAULT_TIMEZONE
                                : calendar.getTimezone(),
                        (left, right) -> left));
        return tasks.stream()
                .map(task -> new ReminderScheduleEntry(
                        Reminder.TARGET_TASK,
                        task.getId(),
                        null,
                        task.getTitle(),
                        null,
                        task.getDueAt().toInstant(),
                        zones.getOrDefault(task.getCalendarId(), DEFAULT_TIMEZONE),
                        sortedMinutes(taskReminders.get(task.getId()))))
                .toList();
    }

    private List<Integer> sortedMinutes(List<Integer> minutes) {
        return minutes.stream().distinct().sorted().toList();
    }

    /**
     * 提醒只能挂在自己有权访问的日程 / 待办上，否则任何人都能给别人的日程设提醒。
     */
    private void requireOwnership(Long identityId, String targetType, Long targetId) {
        if (!TARGET_TYPES.contains(targetType)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "targetType 取值非法: " + targetType);
        }
        if (Reminder.TARGET_EVENT.equals(targetType)) {
            eventService.requireOwned(identityId, targetId);
        } else {
            taskService.requireOwned(identityId, targetId);
        }
    }
}
