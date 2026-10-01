package com.chronoflow.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.personal.dto.EventOccurrence;
import com.chronoflow.personal.dto.PersonalDtos.EventCreateRequest;
import com.chronoflow.personal.dto.PersonalDtos.EventScope;
import com.chronoflow.personal.dto.PersonalDtos.EventUpdateRequest;
import com.chronoflow.personal.entity.Calendar;
import com.chronoflow.personal.entity.Event;
import com.chronoflow.personal.entity.EventException;
import com.chronoflow.personal.entity.Task;
import com.chronoflow.personal.mapper.EventExceptionMapper;
import com.chronoflow.personal.mapper.EventMapper;
import com.chronoflow.personal.mapper.SearchMapper;
import com.chronoflow.personal.mapper.TaskMapper;
import com.chronoflow.personal.recurrence.RecurrenceExpander;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 个人日程。支持 RRULE 重复、重复例外，以及 THIS / FUTURE / ALL 三种编辑范围（spec §4.1.2）。
 */
@Service
public class EventService {

    private final EventMapper eventMapper;
    private final EventExceptionMapper eventExceptionMapper;
    private final CalendarService calendarService;
    private final RecurrenceExpander expander;
    private final TaskMapper taskMapper;
    /** 「全部日程」复用它那条带 ESCAPE 的 ILIKE SQL，避免两处转义规则漂移。 */
    private final SearchMapper searchMapper;

    /** 「关联日程」候选列表的默认与最大条数（spec §4.1.6）。 */
    private static final int DEFAULT_LIST_LIMIT = 200;
    private static final int MAX_LIST_LIMIT = 500;

    private static final Set<String> STATUSES =
            Set.of(Event.STATUS_CONFIRMED, Event.STATUS_TENTATIVE, Event.STATUS_CANCELLED);
    private static final Set<String> AVAILABILITIES =
            Set.of(Event.AVAILABILITY_BUSY, Event.AVAILABILITY_FREE);
    private static final Set<String> PRIORITIES = Set.of("LOW", "NORMAL", "HIGH", "URGENT");

    public EventService(EventMapper eventMapper,
                        EventExceptionMapper eventExceptionMapper,
                        CalendarService calendarService,
                        RecurrenceExpander expander,
                        TaskMapper taskMapper,
                        SearchMapper searchMapper) {
        this.eventMapper = eventMapper;
        this.eventExceptionMapper = eventExceptionMapper;
        this.calendarService = calendarService;
        this.expander = expander;
        this.taskMapper = taskMapper;
        this.searchMapper = searchMapper;
    }

    // ------------------------------------------------------------------ 写入

    @Transactional
    public Event create(Long identityId, EventCreateRequest request) {
        Calendar calendar = request.calendarId() == null
                ? calendarService.defaultCalendar(identityId)
                : calendarService.requireOwned(identityId, request.calendarId());

        expander.validate(request.rrule());

        Event event = new Event();
        event.setCalendarId(calendar.getId());
        event.setCreatorIdentityId(identityId);
        event.setSourceType(Event.SOURCE_PERSONAL);
        event.setTitle(request.title());
        event.setDescription(request.description());
        event.setLocationName(request.locationName());
        event.setLocationAddress(request.locationAddress());
        // 详细地址与地点相互独立、都可空（spec §5.9）
        event.setLocationDetail(blankToNull(request.locationDetail()));
        event.setPoiId(request.poiId());
        applyCoordinates(event, request.latitude(), request.longitude());
        event.setAt(request.at());
        event.setTimezone(StringUtils.hasText(request.timezone()) ? request.timezone() : calendar.getTimezone());
        event.setRrule(request.rrule());
        event.setStatus(choice(request.status(), STATUSES, Event.STATUS_CONFIRMED, "日程状态"));
        event.setAvailability(choice(request.availability(), AVAILABILITIES, Event.AVAILABILITY_BUSY, "忙碌状态"));
        event.setColor(request.color());
        event.setPriority(choice(request.priority(), PRIORITIES, Event.PRIORITY_NORMAL, "优先级"));
        event.setCategory(request.category());
        event.setUrl(request.url());
        event.setTravelTimeMinutes(request.travelTimeMinutes());
        event.setUpdatedAfterDispatch(false);
        eventMapper.insert(event);
        return event;
    }

    /**
     * 编辑日程。范围语义：
     * <ul>
     *   <li>{@code ALL}：修改整条序列；</li>
     *   <li>{@code THIS}：仅本次，写入 {@code event_exception}（MODIFIED）；</li>
     *   <li>{@code FUTURE}：本次及以后，截断原序列并克隆出新序列。</li>
     * </ul>
     */
    @Transactional
    public Event update(Long identityId, Long eventId, EventUpdateRequest request) {
        Event event = requireOwned(identityId, eventId);
        EventScope scope = request.scope() == null ? EventScope.ALL : request.scope();

        if (scope == EventScope.ALL) {
            expander.validate(request.rrule());
            applyFields(event, request);
            eventMapper.updateById(event);
            return event;
        }

        requireRecurring(event, scope);
        LocalDate occurrenceDate = requireOccurrenceDate(request.occurrenceDate());
        if (scope == EventScope.THIS) {
            upsertModifiedException(event, occurrenceDate, request);
            return event;
        }
        return splitFuture(identityId, event, occurrenceDate, request);
    }

    /**
     * 删除日程。范围语义同 {@link #update}：{@code THIS} 写入 CANCELLED 例外，
     * {@code FUTURE} 直接截断序列。
     */
    @Transactional
    public void delete(Long identityId, Long eventId, EventScope scope, LocalDate occurrenceDate) {
        Event event = requireOwned(identityId, eventId);
        EventScope effectiveScope = scope == null ? EventScope.ALL : scope;

        if (effectiveScope == EventScope.ALL) {
            softDelete(event);
            return;
        }

        requireRecurring(event, effectiveScope);
        LocalDate target = requireOccurrenceDate(occurrenceDate);
        if (effectiveScope == EventScope.THIS) {
            upsertCancelledException(event, target);
            return;
        }
        event.setRruleUntil(truncateBefore(event, target));
        eventMapper.updateById(event);
    }

    // ------------------------------------------------------------------ 查询

    public Event get(Long identityId, Long eventId) {
        return requireOwned(identityId, eventId);
    }

    /**
     * 日历视图范围查询：合并展开重复日程，按时间升序返回实例。
     */
    public List<EventOccurrence> rangeQuery(Long identityId,
                                            List<Long> calendarIds,
                                            Instant rangeStart,
                                            Instant rangeEnd) {
        if (!rangeStart.isBefore(rangeEnd)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "结束时间必须晚于开始时间");
        }

        List<Long> targetCalendarIds;
        if (calendarIds == null || calendarIds.isEmpty()) {
            targetCalendarIds = calendarService.list(identityId).stream().map(Calendar::getId).toList();
        } else {
            for (Long id : calendarIds) {
                calendarService.requireOwned(identityId, id);
            }
            targetCalendarIds = List.copyOf(calendarIds);
        }
        if (targetCalendarIds.isEmpty()) {
            return List.of();
        }

        List<Event> events = eventMapper.selectInRange(
                targetCalendarIds,
                OffsetDateTime.ofInstant(rangeStart, ZoneOffset.UTC),
                OffsetDateTime.ofInstant(rangeEnd, ZoneOffset.UTC));
        if (events.isEmpty()) {
            return List.of();
        }

        Map<Long, List<EventException>> exceptionsByEvent = eventExceptionMapper.selectList(
                        new LambdaQueryWrapper<EventException>()
                                .in(EventException::getEventId, events.stream().map(Event::getId).toList()))
                .stream()
                .collect(Collectors.groupingBy(EventException::getEventId));

        List<EventOccurrence> occurrences = new ArrayList<>();
        for (Event event : events) {
            occurrences.addAll(expander.expand(
                    event,
                    exceptionsByEvent.getOrDefault(event.getId(), List.of()),
                    rangeStart,
                    rangeEnd));
        }
        occurrences.sort(Comparator.comparing(EventOccurrence::at)
                .thenComparing(EventOccurrence::eventId));
        return occurrences;
    }

    /**
     * 我的**全部日程**（「关联日程」候选，spec §4.1.6），按时间倒序，可按关键字过滤。
     *
     * <p>为什么不复用 {@link #rangeQuery}：它必须给时间范围、而且会把重复日程展开成每一次实例 ——
     * 拉一年就是几百条，用来当候选列表既慢又不准（用户要关联的是**那条日程**，
     * 而 `task.event_id` 指向的也正是序列本身，不是某一次出现）。
     *
     * <p>关键字走的是检索那条带 {@code ESCAPE} 的 ILIKE SQL：空关键字时模式串是 `%%`，
     * 于是「列全部」和「按关键字过滤」共用一条 SQL，转义规则只有一份。
     */
    public List<EventOccurrence> listAll(Long identityId, String keyword, Integer limit) {
        int effectiveLimit = limit == null
                ? DEFAULT_LIST_LIMIT
                : Math.clamp(limit, 1, MAX_LIST_LIMIT);
        return searchMapper.searchEvents(identityId, LikeQuery.pattern(keyword), effectiveLimit)
                .stream()
                .map(EventService::toSeriesOccurrence)
                .toList();
    }

    /**
     * 原始日程 → 实例视图（**不展开**）：一条重复日程只出现一次，
     * `occurrenceDate` 为 null，时间就是序列自己的开始 / 结束时刻。
     */
    private static EventOccurrence toSeriesOccurrence(Event event) {
        return new EventOccurrence(
                event.getId(),
                event.getCalendarId(),
                event.getTitle(),
                event.getLocationName(),
                event.getLocationAddress(),
                event.getLocationDetail(),
                event.getAt().toInstant(),
                StringUtils.hasText(event.getTimezone()) ? event.getTimezone() : "Asia/Shanghai",
                StringUtils.hasText(event.getRrule()),
                null,
                false);
    }

    public Event requireOwned(Long identityId, Long eventId) {
        Event event = eventMapper.selectById(eventId);
        if (event == null || event.getDeletedAt() != null) {
            throw BizException.of(ErrorCode.FORBIDDEN, "日程不存在或不属于当前身份");
        }
        calendarService.requireOwned(identityId, event.getCalendarId());
        return event;
    }

    // ------------------------------------------------------------- 内部实现

    private void applyFields(Event event, EventUpdateRequest request) {
        if (StringUtils.hasText(request.title())) {
            event.setTitle(request.title());
        }
        if (request.description() != null) {
            event.setDescription(request.description());
        }
        if (request.status() != null) {
            event.setStatus(choice(request.status(), STATUSES, Event.STATUS_CONFIRMED, "日程状态"));
        }
        if (request.availability() != null) {
            event.setAvailability(choice(request.availability(), AVAILABILITIES, Event.AVAILABILITY_BUSY, "忙碌状态"));
        }
        if (request.color() != null) {
            event.setColor(blankToNull(request.color()));
        }
        if (request.priority() != null) {
            event.setPriority(choice(request.priority(), PRIORITIES, Event.PRIORITY_NORMAL, "优先级"));
        }
        if (request.category() != null) {
            event.setCategory(blankToNull(request.category()));
        }
        if (request.url() != null) {
            event.setUrl(blankToNull(request.url()));
        }
        if (request.travelTimeMinutes() != null) {
            event.setTravelTimeMinutes(request.travelTimeMinutes());
        }
        if (request.locationName() != null) {
            if (!StringUtils.hasText(request.locationName())) {
                // 显式清空地点：名称、地址、坐标一起清掉，
                // 否则会留下「有坐标却没有名字」的脏数据，且在 §5.9 的成对约束下无法通过校验
                event.setLocationName(null);
                event.setLocationAddress(null);
                event.setPoiId(null);
                event.setLatitude(null);
                event.setLongitude(null);
                event.setCoordinateSystem(null);
            } else {
                event.setLocationName(request.locationName());
                if (request.locationAddress() != null) {
                    event.setLocationAddress(blankToNull(request.locationAddress()));
                }
                if (request.poiId() != null) {
                    event.setPoiId(blankToNull(request.poiId()));
                }
                if (request.latitude() != null || request.longitude() != null) {
                    applyCoordinates(event, request.latitude(), request.longitude());
                }
            }
        }
        // 详细地址独立于地点：清空地点不该顺手把用户手写的教室号也抹掉
        if (request.locationDetail() != null) {
            event.setLocationDetail(blankToNull(request.locationDetail()));
        }
        if (request.at() != null) {
            event.setAt(request.at());
        }
        if (StringUtils.hasText(request.timezone())) {
            event.setTimezone(request.timezone());
        }
        if (request.rrule() != null) {
            event.setRrule(StringUtils.hasText(request.rrule()) ? request.rrule() : null);
        }
    }

    /**
     * 枚举取值统一在这里校验：让脏值以业务错误码返回，
     * 而不是写进库后被数据库约束拒绝、报出对用户毫无意义的约束名。
     */
    private static String choice(String value, Set<String> allowed, String fallback, String label) {
        if (!StringUtils.hasText(value)) {
            return fallback;
        }
        String normalized = value.trim().toUpperCase(Locale.ROOT);
        if (!allowed.contains(normalized)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, label + "取值非法: " + value);
        }
        return normalized;
    }

    private static String blankToNull(String value) {
        return StringUtils.hasText(value) ? value : null;
    }

    /**
     * 写入坐标。
     *
     * 坐标必须成对出现，且一律标注为 GCJ-02：客户端提交的坐标来自国内地图服务，
     * 本身就是 GCJ-02，服务端不采信客户端自报的坐标系（spec §5.9）。
     */
    private static void applyCoordinates(Event event, BigDecimal latitude, BigDecimal longitude) {
        if (latitude == null && longitude == null) {
            event.setLatitude(null);
            event.setLongitude(null);
            event.setCoordinateSystem(null);
            return;
        }
        if (latitude == null || longitude == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "经纬度必须成对提供");
        }
        if (latitude.compareTo(BigDecimal.valueOf(-90)) < 0 || latitude.compareTo(BigDecimal.valueOf(90)) > 0
                || longitude.compareTo(BigDecimal.valueOf(-180)) < 0
                || longitude.compareTo(BigDecimal.valueOf(180)) > 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "经纬度超出有效范围");
        }
        event.setLatitude(latitude);
        event.setLongitude(longitude);
        event.setCoordinateSystem(Event.COORDINATE_GCJ02);
    }

    private void upsertModifiedException(Event event, LocalDate occurrenceDate, EventUpdateRequest request) {
        EventException exception = findException(event.getId(), occurrenceDate);
        if (exception == null) {
            exception = new EventException();
            exception.setEventId(event.getId());
            exception.setOccurrenceDate(occurrenceDate);
        }
        exception.setExceptionType(EventException.MODIFIED);
        exception.setOverrideTitle(StringUtils.hasText(request.title()) ? request.title() : null);
        exception.setOverrideAt(request.at());

        if (exception.getId() == null) {
            eventExceptionMapper.insert(exception);
        } else {
            eventExceptionMapper.updateById(exception);
        }
    }

    private void upsertCancelledException(Event event, LocalDate occurrenceDate) {
        EventException exception = findException(event.getId(), occurrenceDate);
        if (exception == null) {
            exception = new EventException();
            exception.setEventId(event.getId());
            exception.setOccurrenceDate(occurrenceDate);
        }
        exception.setExceptionType(EventException.CANCELLED);
        exception.setOverrideTitle(null);
        exception.setOverrideAt(null);
        if (exception.getId() == null) {
            eventExceptionMapper.insert(exception);
        } else {
            eventExceptionMapper.updateById(exception);
        }
    }

    /**
     * 拆分序列：原序列在 occurrenceDate 之前结束，从该次出现开始克隆出一条新序列并套用新值。
     *
     * <p>已知限制：若原 RRULE 使用 COUNT，拆分后新序列会重新计数（建议使用 UNTIL 表达结束条件）。
     */
    private Event splitFuture(Long identityId, Event event, LocalDate occurrenceDate, EventUpdateRequest request) {
        expander.validate(request.rrule());
        OffsetDateTime occurrenceStart = occurrenceStart(event, occurrenceDate);

        Event split = new Event();
        BeanUtils.copyProperties(event, split);
        split.setId(null);
        split.setCreatedAt(null);
        split.setUpdatedAt(null);
        split.setDeletedAt(null);
        split.setAt(occurrenceStart);
        split.setRruleUntil(null);
        split.setCreatorIdentityId(identityId);
        applyFields(split, request);
        eventMapper.insert(split);

        event.setRruleUntil(truncateBefore(event, occurrenceDate));
        eventMapper.updateById(event);
        return split;
    }

    /**
     * 计算「本次出现之前一点点」作为原序列截止时间，使该次及以后不再由原序列产生。
     *
     * <p>这里必须退让**毫秒**而不是纳秒：PostgreSQL 的 {@code timestamptz} 只保留到微秒，
     * 退让 1 纳秒会被四舍五入回该次出现的时刻，导致截断失效（该次出现仍被包含）。
     */
    private OffsetDateTime truncateBefore(Event event, LocalDate occurrenceDate) {
        return occurrenceStart(event, occurrenceDate).minusNanos(1_000_000L);
    }

    private OffsetDateTime occurrenceStart(Event event, LocalDate occurrenceDate) {
        ZoneId zone = resolveZone(event.getTimezone());
        LocalTime localTime = event.getAt().atZoneSameInstant(zone).toLocalTime();
        return occurrenceDate.atTime(localTime).atZone(zone).toOffsetDateTime();
    }

    private ZoneId resolveZone(String timezone) {
        if (!StringUtils.hasText(timezone)) {
            return ZoneOffset.UTC;
        }
        try {
            return ZoneId.of(timezone);
        } catch (RuntimeException ex) {
            return ZoneOffset.UTC;
        }
    }

    private EventException findException(Long eventId, LocalDate occurrenceDate) {
        return eventExceptionMapper.selectOne(new LambdaQueryWrapper<EventException>()
                .eq(EventException::getEventId, eventId)
                .eq(EventException::getOccurrenceDate, occurrenceDate));
    }

    private void softDelete(Event event) {
        event.setDeletedAt(OffsetDateTime.now(ZoneOffset.UTC));
        event.setStatus(Event.STATUS_CANCELLED);
        eventMapper.updateById(event);
        // 删除日程**不删除**关联的待办，只解除关联（spec §4.1.6）：
        // 待办是用户自己的事，不该被日程的删除带崩。
        taskMapper.update(null, new LambdaUpdateWrapper<Task>()
                .eq(Task::getEventId, event.getId())
                .set(Task::getEventId, null));
    }

    private void requireRecurring(Event event, EventScope scope) {
        if (!StringUtils.hasText(event.getRrule())) {
            throw BizException.of(ErrorCode.PARAM_INVALID,
                    "非重复日程不支持 scope=" + scope + "，请使用 scope=ALL");
        }
    }

    private LocalDate requireOccurrenceDate(LocalDate occurrenceDate) {
        if (occurrenceDate == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "scope=THIS/FUTURE 必须提供 occurrenceDate");
        }
        return occurrenceDate;
    }

}
