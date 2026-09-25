package com.xatodo.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.ReminderDtos.ReminderItem;
import com.xatodo.personal.dto.ReminderDtos.ReminderResponse;
import com.xatodo.personal.dto.ReminderDtos.SetRemindersRequest;
import com.xatodo.personal.entity.Reminder;
import com.xatodo.personal.mapper.ReminderMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Set;

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

    private final ReminderMapper reminderMapper;
    private final EventService eventService;
    private final TaskService taskService;

    public ReminderService(ReminderMapper reminderMapper, EventService eventService, TaskService taskService) {
        this.reminderMapper = reminderMapper;
        this.eventService = eventService;
        this.taskService = taskService;
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
