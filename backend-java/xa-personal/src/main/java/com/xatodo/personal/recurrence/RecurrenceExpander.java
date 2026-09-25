package com.xatodo.personal.recurrence;

import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.EventOccurrence;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.entity.EventException;
import org.dmfs.rfc5545.DateTime;
import org.dmfs.rfc5545.recur.InvalidRecurrenceRuleException;
import org.dmfs.rfc5545.recur.RecurrenceRule;
import org.dmfs.rfc5545.recur.RecurrenceRuleIterator;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/**
 * 重复日程展开器：把 RRULE 在查询区间内展开为具体实例，并应用重复例外（spec §4.1.2）。
 *
 * <p>关键点：重复规则按**事件自身时区**的墙上时间计算。例如「每周一 09:00（Asia/Shanghai）」
 * 必须落在当地的周一上午，而不是 UTC 的周一。因此构造 lib-recur 的起始时间时携带事件时区。
 */
@Component
public class RecurrenceExpander {

    /** 单次展开的实例上限，防御无界规则在超大区间上造成的性能问题。 */
    private static final int MAX_OCCURRENCES = 10_000;

    /**
     * 校验 RRULE 是否合法，非法时抛出 {@link ErrorCode#RRULE_INVALID}。
     */
    public void validate(String rrule) {
        if (!StringUtils.hasText(rrule)) {
            return;
        }
        try {
            new RecurrenceRule(rrule);
        } catch (InvalidRecurrenceRuleException ex) {
            throw BizException.of(ErrorCode.RRULE_INVALID, "重复规则无法解析: " + rrule);
        }
    }

    /**
     * 展开日程在 [rangeStart, rangeEnd) 内的全部实例，按开始时间升序返回。
     */
    public List<EventOccurrence> expand(Event event,
                                        List<EventException> exceptions,
                                        Instant rangeStart,
                                        Instant rangeEnd) {
        Instant eventStart = event.getStartAt().toInstant();
        Instant eventEnd = event.getEndAt().toInstant();

        if (!StringUtils.hasText(event.getRrule())) {
            if (!overlaps(eventStart, eventEnd, rangeStart, rangeEnd)) {
                return List.of();
            }
            return List.of(new EventOccurrence(
                    event.getId(), event.getCalendarId(), event.getTitle(), event.getLocation(),
                    eventStart, eventEnd, Boolean.TRUE.equals(event.getAllDay()),
                    event.getTimezone(), false, null, false));
        }

        ZoneId zone = resolveZone(event.getTimezone());
        long durationMillis = Duration.between(event.getStartAt(), event.getEndAt()).toMillis();
        Map<LocalDate, EventException> exceptionByDate = indexExceptions(exceptions);

        Instant hardStop = event.getRruleUntil() == null
                ? rangeEnd
                : min(rangeEnd, event.getRruleUntil().toInstant());

        RecurrenceRule rule = parse(event.getRrule());
        RecurrenceRuleIterator iterator =
                rule.iterator(new DateTime(TimeZone.getTimeZone(zone), eventStart.toEpochMilli()));

        List<EventOccurrence> occurrences = new ArrayList<>();
        int guard = 0;
        while (iterator.hasNext() && guard++ < MAX_OCCURRENCES) {
            DateTime next = iterator.nextDateTime();
            Instant start = Instant.ofEpochMilli(next.getTimestamp());
            if (start.isAfter(hardStop)) {
                break;
            }

            LocalDate occurrenceDate = LocalDate.ofInstant(start, zone);
            EventException exception = exceptionByDate.get(occurrenceDate);
            if (exception != null && EventException.CANCELLED.equals(exception.getExceptionType())) {
                continue;
            }

            boolean modified = exception != null && EventException.MODIFIED.equals(exception.getExceptionType());
            Instant effectiveStart = modified && exception.getOverrideStartAt() != null
                    ? exception.getOverrideStartAt().toInstant()
                    : start;
            Instant effectiveEnd = modified && exception.getOverrideEndAt() != null
                    ? exception.getOverrideEndAt().toInstant()
                    : effectiveStart.plusMillis(durationMillis);
            String title = modified && StringUtils.hasText(exception.getOverrideTitle())
                    ? exception.getOverrideTitle()
                    : event.getTitle();

            if (!overlaps(effectiveStart, effectiveEnd, rangeStart, rangeEnd)) {
                continue;
            }

            occurrences.add(new EventOccurrence(
                    event.getId(), event.getCalendarId(), title, event.getLocation(),
                    effectiveStart, effectiveEnd, Boolean.TRUE.equals(event.getAllDay()),
                    event.getTimezone(), true, occurrenceDate, modified));
        }

        occurrences.sort(Comparator.comparing(EventOccurrence::startAt));
        return occurrences;
    }

    /**
     * 计算某次出现的「本地日期」，用于定位重复例外（写入例外时使用同一套计算）。
     */
    public LocalDate occurrenceDateOf(Event event, Instant occurrenceStart) {
        return LocalDate.ofInstant(occurrenceStart, resolveZone(event.getTimezone()));
    }

    private RecurrenceRule parse(String rrule) {
        try {
            return new RecurrenceRule(rrule);
        } catch (InvalidRecurrenceRuleException ex) {
            throw BizException.of(ErrorCode.RRULE_INVALID, "重复规则无法解析: " + rrule);
        }
    }

    private Map<LocalDate, EventException> indexExceptions(List<EventException> exceptions) {
        Map<LocalDate, EventException> map = new HashMap<>();
        for (EventException exception : exceptions) {
            map.put(exception.getOccurrenceDate(), exception);
        }
        return map;
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

    private static boolean overlaps(Instant start, Instant end, Instant rangeStart, Instant rangeEnd) {
        return start.isBefore(rangeEnd) && end.isAfter(rangeStart);
    }

    private static Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }
}
