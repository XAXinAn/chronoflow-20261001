package com.xatodo.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.EventOccurrence;
import com.xatodo.personal.dto.SearchDtos.SearchResultItem;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.entity.EventException;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.mapper.EventExceptionMapper;
import com.xatodo.personal.mapper.SearchMapper;
import com.xatodo.personal.recurrence.RecurrenceExpander;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static com.xatodo.personal.dto.SearchDtos.TYPE_EVENT;
import static com.xatodo.personal.dto.SearchDtos.TYPE_TASK;

/**
 * 跨日程与待办的关键字检索（spec §4.1.7 / §6.2 GET /search）。
 *
 * <p>三个容易做错的地方，这里都单独处理：
 * <ol>
 *   <li><b>不能只搜当前月份</b>：否则「搜上个月那个会」永远搜不到，所以是服务端全量检索，不带时间范围；</li>
 *   <li><b>重复日程要给出「最近一次」</b>：命中的是一整条序列，直接回原始 start_at 会把用户带回几个月前；
 *       这里展开出下一次实例，连同 occurrence_date 一起返回，App 点进去就是那一次；</li>
 *   <li><b>关键字里的 % 和 _ 必须转义</b>：不转义就成了通配符，搜「50%」会命中所有日程。</li>
 * </ol>
 */
@Service
public class SearchService {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 50;
    /** 找「下一次实例」的展开窗口：跨两年，足够覆盖 YEARLY 规则。 */
    private static final Duration NEXT_OCCURRENCE_WINDOW = Duration.ofDays(730);

    private final SearchMapper searchMapper;
    private final EventExceptionMapper eventExceptionMapper;
    private final RecurrenceExpander expander;

    public SearchService(SearchMapper searchMapper,
                         EventExceptionMapper eventExceptionMapper,
                         RecurrenceExpander expander) {
        this.searchMapper = searchMapper;
        this.eventExceptionMapper = eventExceptionMapper;
        this.expander = expander;
    }

    public List<SearchResultItem> search(Long identityId,
                                         String keyword,
                                         List<String> types,
                                         Integer limit) {
        String trimmed = keyword == null ? "" : keyword.trim();
        if (trimmed.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "检索关键字不能为空");
        }
        Set<String> wanted = parseTypes(types);
        int effectiveLimit = limit == null ? DEFAULT_LIMIT : Math.clamp(limit, 1, MAX_LIMIT);
        String pattern = likePattern(trimmed);

        List<SearchResultItem> items = new ArrayList<>();
        if (wanted.contains(TYPE_EVENT)) {
            items.addAll(searchEvents(identityId, pattern, effectiveLimit));
        }
        if (wanted.contains(TYPE_TASK)) {
            items.addAll(searchTasks(identityId, pattern, effectiveLimit));
        }

        // 按时间倒序、无时间的待办排最后：用户找「最近那个」时不该先翻到一堆「待安排」
        items.sort(Comparator.comparing(SearchService::sortInstant,
                Comparator.nullsLast(Comparator.reverseOrder())));
        if (items.size() > effectiveLimit) {
            return List.copyOf(items.subList(0, effectiveLimit));
        }
        return List.copyOf(items);
    }

    private List<SearchResultItem> searchEvents(Long identityId, String pattern, int limit) {
        List<Event> events = searchMapper.searchEvents(identityId, pattern, limit);
        if (events.isEmpty()) {
            return List.of();
        }
        // 重复日程的例外一次性批量取出来：逐条查就是 N+1
        Map<Long, List<EventException>> exceptionsByEvent = eventExceptionMapper.selectList(
                        new LambdaQueryWrapper<EventException>()
                                .in(EventException::getEventId, events.stream().map(Event::getId).toList()))
                .stream()
                .collect(Collectors.groupingBy(EventException::getEventId));

        Instant now = Instant.now();
        List<SearchResultItem> items = new ArrayList<>(events.size());
        for (Event event : events) {
            items.add(toEventItem(event, exceptionsByEvent.getOrDefault(event.getId(), List.of()), now));
        }
        return items;
    }

    private SearchResultItem toEventItem(Event event, List<EventException> exceptions, Instant now) {
        boolean recurring = StringUtils.hasText(event.getRrule());
        ZoneId zone = resolveZone(event.getTimezone());
        OffsetDateTime start = event.getStartAt();
        OffsetDateTime end = event.getEndAt();
        LocalDate occurrenceDate = null;

        if (recurring) {
            List<EventOccurrence> upcoming =
                    expander.expand(event, exceptions, now, now.plus(NEXT_OCCURRENCE_WINDOW));
            if (!upcoming.isEmpty()) {
                EventOccurrence next = upcoming.getFirst();
                start = OffsetDateTime.ofInstant(next.startAt(), zone);
                end = OffsetDateTime.ofInstant(next.endAt(), zone);
                occurrenceDate = next.occurrenceDate();
            }
            // 序列已经走完（rrule_until 已过）：退回序列起点，occurrenceDate 保持 null，
            // 让 App 打开整条序列而不是某个不存在的实例
        }

        return new SearchResultItem(
                TYPE_EVENT, event.getId(), event.getTitle(), start, end,
                Boolean.TRUE.equals(event.getAllDay()),
                StringUtils.hasText(event.getTimezone()) ? event.getTimezone() : "UTC",
                event.getLocationName(), null,
                event.getStatus(), event.getPriority(), recurring, occurrenceDate);
    }

    private List<SearchResultItem> searchTasks(Long identityId, String pattern, int limit) {
        List<Task> tasks = searchMapper.searchTasks(identityId, pattern, limit);
        List<SearchResultItem> items = new ArrayList<>(tasks.size());
        for (Task task : tasks) {
            items.add(new SearchResultItem(
                    TYPE_TASK, task.getId(), task.getTitle(), null, null,
                    Boolean.TRUE.equals(task.getAllDay()), null, null,
                    task.getDueAt(), task.getStatus(), task.getPriority(), null, null));
        }
        return items;
    }

    /** 排序时刻：日程取开始时间，待办取截止时间；都没有则为 null（排最后）。 */
    private static Instant sortInstant(SearchResultItem item) {
        OffsetDateTime at = TYPE_EVENT.equals(item.type()) ? item.startAt() : item.dueAt();
        return at == null ? null : at.toInstant();
    }

    private static Set<String> parseTypes(List<String> types) {
        if (types == null || types.isEmpty()) {
            return Set.of(TYPE_EVENT, TYPE_TASK);
        }
        Set<String> result = new HashSet<>();
        for (String raw : types) {
            for (String part : raw.split(",")) {
                String value = part.trim().toUpperCase(Locale.ROOT);
                if (value.isEmpty()) {
                    continue;
                }
                if (!TYPE_EVENT.equals(value) && !TYPE_TASK.equals(value)) {
                    throw BizException.of(ErrorCode.PARAM_INVALID, "types 取值非法: " + part.trim());
                }
                result.add(value);
            }
        }
        return result.isEmpty() ? Set.of(TYPE_EVENT, TYPE_TASK) : result;
    }

    /** 关键字 → LIKE 模式串。转义 `\`、`%`、`_`，配合 SQL 里的 {@code ESCAPE '\'}。 */
    private static String likePattern(String keyword) {
        String escaped = keyword
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_");
        return "%" + escaped + "%";
    }

    /** 事件时区非法时退回 UTC：脏数据不该让整个检索接口 500。 */
    private static ZoneId resolveZone(String timezone) {
        if (!StringUtils.hasText(timezone)) {
            return ZoneOffset.UTC;
        }
        try {
            return ZoneId.of(timezone);
        } catch (Exception ex) {
            return ZoneOffset.UTC;
        }
    }
}
