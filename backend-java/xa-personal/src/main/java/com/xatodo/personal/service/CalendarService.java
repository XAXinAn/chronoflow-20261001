package com.xatodo.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.PersonalDtos.CalendarCreateRequest;
import com.xatodo.personal.dto.PersonalDtos.CalendarUpdateRequest;
import com.xatodo.personal.entity.Calendar;
import com.xatodo.personal.mapper.CalendarMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;

/**
 * 个人日历。默认日历「我的日程」在首次访问时自动创建，避免出现无日历可用的空状态。
 */
@Service
public class CalendarService {

    private static final String STATUS_ACTIVE = "ACTIVE";
    private static final String STATUS_DISABLED = "DISABLED";
    private static final String DEFAULT_CALENDAR_NAME = "我的日程";
    private static final String DEFAULT_CALENDAR_COLOR = "#0A0A0A";
    private static final String DEFAULT_TIMEZONE = "Asia/Shanghai";

    private final CalendarMapper calendarMapper;

    public CalendarService(CalendarMapper calendarMapper) {
        this.calendarMapper = calendarMapper;
    }

    @Transactional
    public List<Calendar> list(Long identityId) {
        ensureDefaultCalendar(identityId);
        return calendarMapper.selectList(new LambdaQueryWrapper<Calendar>()
                .eq(Calendar::getOwnerIdentityId, identityId)
                .eq(Calendar::getStatus, STATUS_ACTIVE)
                .orderByDesc(Calendar::getIsDefault)
                .orderByAsc(Calendar::getId));
    }

    @Transactional
    public Calendar defaultCalendar(Long identityId) {
        Calendar created = ensureDefaultCalendar(identityId);
        if (created != null) {
            return created;
        }
        return calendarMapper.selectOne(new LambdaQueryWrapper<Calendar>()
                .eq(Calendar::getOwnerIdentityId, identityId)
                .eq(Calendar::getStatus, STATUS_ACTIVE)
                .orderByDesc(Calendar::getIsDefault)
                .orderByAsc(Calendar::getId)
                .last("LIMIT 1"));
    }

    /**
     * 若该身份没有任何活跃日历，则创建默认日历；返回新建的日历，否则返回 null。
     */
    @Transactional
    public Calendar ensureDefaultCalendar(Long identityId) {
        Long count = calendarMapper.selectCount(new LambdaQueryWrapper<Calendar>()
                .eq(Calendar::getOwnerIdentityId, identityId)
                .eq(Calendar::getStatus, STATUS_ACTIVE));
        if (count != null && count > 0) {
            return null;
        }
        Calendar calendar = new Calendar();
        calendar.setCalendarType(Calendar.TYPE_PERSONAL);
        calendar.setOwnerIdentityId(identityId);
        calendar.setName(DEFAULT_CALENDAR_NAME);
        calendar.setColor(DEFAULT_CALENDAR_COLOR);
        calendar.setTimezone(DEFAULT_TIMEZONE);
        calendar.setIsDefault(true);
        calendar.setStatus(STATUS_ACTIVE);
        calendarMapper.insert(calendar);
        return calendar;
    }

    @Transactional
    public Calendar create(Long identityId, CalendarCreateRequest request) {
        boolean asDefault = Boolean.TRUE.equals(request.isDefault());
        if (asDefault) {
            clearDefault(identityId);
        }
        Calendar calendar = new Calendar();
        calendar.setCalendarType(Calendar.TYPE_PERSONAL);
        calendar.setOwnerIdentityId(identityId);
        calendar.setName(request.name());
        calendar.setColor(StringUtils.hasText(request.color()) ? request.color() : DEFAULT_CALENDAR_COLOR);
        calendar.setTimezone(StringUtils.hasText(request.timezone()) ? request.timezone() : DEFAULT_TIMEZONE);
        calendar.setIsDefault(asDefault);
        calendar.setStatus(STATUS_ACTIVE);
        calendarMapper.insert(calendar);
        return calendar;
    }

    @Transactional
    public Calendar update(Long identityId, Long calendarId, CalendarUpdateRequest request) {
        Calendar calendar = requireOwned(identityId, calendarId);
        if (StringUtils.hasText(request.name())) {
            calendar.setName(request.name());
        }
        if (StringUtils.hasText(request.color())) {
            calendar.setColor(request.color());
        }
        if (StringUtils.hasText(request.timezone())) {
            calendar.setTimezone(request.timezone());
        }
        if (request.isDefault() != null) {
            if (Boolean.TRUE.equals(request.isDefault())) {
                clearDefault(identityId);
            }
            calendar.setIsDefault(request.isDefault());
        }
        calendarMapper.updateById(calendar);
        return calendar;
    }

    /**
     * 删除即停用。默认日历不可停用，避免身份失去唯一的默认落点。
     */
    @Transactional
    public void disable(Long identityId, Long calendarId) {
        Calendar calendar = requireOwned(identityId, calendarId);
        if (Boolean.TRUE.equals(calendar.getIsDefault())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "默认日历不可删除，请先设置其他默认日历");
        }
        calendar.setStatus(STATUS_DISABLED);
        calendarMapper.updateById(calendar);
    }

    public Calendar requireOwned(Long identityId, Long calendarId) {
        Calendar calendar = calendarMapper.selectById(calendarId);
        if (calendar == null
                || !Calendar.TYPE_PERSONAL.equals(calendar.getCalendarType())
                || !identityId.equals(calendar.getOwnerIdentityId())
                || STATUS_DISABLED.equals(calendar.getStatus())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "日历不存在或不属于当前身份");
        }
        return calendar;
    }

    private void clearDefault(Long identityId) {
        Calendar reset = new Calendar();
        reset.setIsDefault(false);
        calendarMapper.update(reset, new LambdaQueryWrapper<Calendar>()
                .eq(Calendar::getOwnerIdentityId, identityId)
                .eq(Calendar::getIsDefault, true));
    }
}
