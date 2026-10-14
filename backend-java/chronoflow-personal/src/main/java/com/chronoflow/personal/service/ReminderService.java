package com.chronoflow.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.personal.dto.EventOccurrence;
import com.chronoflow.personal.dto.ReminderDtos.ReminderItem;
import com.chronoflow.personal.dto.ReminderDtos.ReminderResponse;
import com.chronoflow.personal.dto.ReminderDtos.ReminderScheduleEntry;
import com.chronoflow.personal.dto.ReminderDtos.SetRemindersRequest;
import com.chronoflow.personal.entity.Calendar;
import com.chronoflow.personal.entity.Reminder;
import com.chronoflow.personal.entity.Task;
import com.chronoflow.personal.mapper.ReminderMapper;
import com.chronoflow.personal.mapper.TaskMapper;
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

    /** 允许的声音档（spec §4.5）。 */
    private static final Set<String> SOUNDS =
            Set.of(Reminder.SOUND_SILENT, Reminder.SOUND_DEFAULT, Reminder.SOUND_ALARM);

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

        // 声音是**按整条日程**的：所有提前量共用一个值
        String sound = request.sound() == null
                ? Reminder.SOUND_DEFAULT
                : request.sound().trim().toUpperCase(java.util.Locale.ROOT);
        if (!SOUNDS.contains(sound)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "sound 取值非法: " + request.sound());
        }

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
            // 到点提醒走 App 本机通知（spec §4.5）。旧代码写死 PUSH，但那时并没有推送调度器，
            // 语义上一直是本机的；这里显式写 LOCAL，与 V22 迁移把历史行改成 LOCAL 保持一致。
            reminder.setChannel(Reminder.CHANNEL_LOCAL);
            reminder.setSound(sound);
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
                        reminder.getChannel(), reminder.getSound(), reminder.getEnabled()))
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

        // 按目标分组后取整组的分钟数 + 声音 + 投递方式（后者对同一条日程是统一的，见 V22）
        Map<String, Map<Long, List<Reminder>>> byTarget = reminders.stream()
                .collect(Collectors.groupingBy(Reminder::getTargetType,
                        Collectors.groupingBy(Reminder::getTargetId)));

        List<ReminderScheduleEntry> entries = new ArrayList<>();
        Map<Long, List<Reminder>> eventReminders =
                byTarget.getOrDefault(Reminder.TARGET_EVENT, Map.of());
        if (!eventReminders.isEmpty()) {
            for (EventOccurrence occurrence
                    : eventService.rangeQuery(identityId, null, rangeStart, rangeEnd)) {
                List<Reminder> rows = eventReminders.get(occurrence.eventId());
                if (rows == null) {
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
                        minutesOf(rows),
                        soundOf(rows)));
            }
        }

        Map<Long, List<Reminder>> taskReminders = byTarget.getOrDefault(Reminder.TARGET_TASK, Map.of());
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
                                                    Map<Long, List<Reminder>> taskReminders) {
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
                        minutesOf(taskReminders.get(task.getId())),
                        soundOf(taskReminders.get(task.getId()))))
                .toList();
    }

    /** 同一个目标的提前量：去重升序。 */
    private List<Integer> minutesOf(List<Reminder> rows) {
        return rows.stream()
                .map(Reminder::getMinutesBefore)
                .distinct()
                .sorted()
                .toList();
    }

    /** 声音档：同一目标的各行应当一致，取第一行；空组不会走到这里。 */
    private String soundOf(List<Reminder> rows) {
        if (rows.isEmpty() || rows.get(0).getSound() == null) {
            return Reminder.SOUND_DEFAULT;
        }
        return rows.get(0).getSound();
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
