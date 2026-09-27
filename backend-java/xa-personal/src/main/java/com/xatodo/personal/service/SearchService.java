package com.xatodo.personal.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.EventOccurrence;
import com.xatodo.personal.dto.OrgEventHit;
import com.xatodo.personal.dto.SearchDtos.SearchResultItem;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.entity.EventException;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.mapper.EventExceptionMapper;
import com.xatodo.personal.mapper.EventMapper;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static com.xatodo.personal.dto.SearchDtos.TYPE_EVENT;
import static com.xatodo.personal.dto.SearchDtos.TYPE_ORG_EVENT;
import static com.xatodo.personal.dto.SearchDtos.TYPE_TASK;

/**
 * 跨日程与待办的关键字检索（spec §4.1.7 / §6.2 GET /search）。
 *
 * <p>检索范围是**当前账号能看到的一切日程与待办**：个人日历里的日程、自己的待办，
 * 以及**我绑定过的所有组织**下发给我的组织日程——不用先切到某个组织再搜。
 *
 * <p>几个容易做错的地方，这里都单独处理：
 * <ol>
 *   <li><b>不能只搜当前月份</b>：否则「搜上个月那个会」永远搜不到，所以是服务端全量检索；</li>
 *   <li><b>重复日程要给出「最近一次」</b>：命中的是一整条序列，直接回原始 start_at 会把人带回几个月前；</li>
 *   <li><b>关键字里的 % 和 _ 必须转义</b>：不转义就成了通配符，搜「50%」会命中所有日程；</li>
 *   <li><b>撤回过的组织下发不出现</b>：否则用户会搜到一个点开就没了的活动（见 SearchMapper）。</li>
 * </ol>
 */
@Service
public class SearchService {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 50;
    private static final Set<String> ALL_TYPES = Set.of(TYPE_EVENT, TYPE_TASK, TYPE_ORG_EVENT);
    /** 找「下一次实例」的展开窗口：跨两年，足够覆盖 YEARLY 规则。 */
    private static final Duration NEXT_OCCURRENCE_WINDOW = Duration.ofDays(730);

    private final SearchMapper searchMapper;
    private final EventMapper eventMapper;
    private final EventExceptionMapper eventExceptionMapper;
    private final RecurrenceExpander expander;

    public SearchService(SearchMapper searchMapper,
                         EventMapper eventMapper,
                         EventExceptionMapper eventExceptionMapper,
                         RecurrenceExpander expander) {
        this.searchMapper = searchMapper;
        this.eventMapper = eventMapper;
        this.eventExceptionMapper = eventExceptionMapper;
        this.expander = expander;
    }

    public List<SearchResultItem> search(Long identityId,
                                         Long accountId,
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
        if (wanted.contains(TYPE_ORG_EVENT)) {
            // 组织日程按**账号**搜：一个人可以绑多个组织，跨组织一起给结果
            items.addAll(searchOrgEvents(accountId, pattern, effectiveLimit));
        }

        // 排序与来源无关：用户脑子里没有「这条是哪个模块的数据」，只有「我要找的那件事在什么时候」。
        // 按时间倒序，无时间的待办排最后。
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
        Map<Long, List<EventException>> exceptionsByEvent = exceptionsFor(
                events.stream().map(Event::getId).toList());

        Instant now = Instant.now();
        List<SearchResultItem> items = new ArrayList<>(events.size());
        for (Event event : events) {
            Occurrence occurrence = resolveOccurrence(
                    event, exceptionsByEvent.getOrDefault(event.getId(), List.of()), now);
            items.add(new SearchResultItem(
                    TYPE_EVENT, event.getId(), event.getTitle(),
                    occurrence.start(), occurrence.end(),
                    Boolean.TRUE.equals(event.getAllDay()),
                    StringUtils.hasText(event.getTimezone()) ? event.getTimezone() : "UTC",
                    event.getLocationName(), null,
                    event.getStatus(), event.getPriority(),
                    StringUtils.hasText(event.getRrule()), occurrence.occurrenceDate(),
                    null, null, null));
        }
        return items;
    }

    private List<SearchResultItem> searchTasks(Long identityId, String pattern, int limit) {
        List<Task> tasks = searchMapper.searchTasks(identityId, pattern, limit);
        List<SearchResultItem> items = new ArrayList<>(tasks.size());
        for (Task task : tasks) {
            items.add(new SearchResultItem(
                    TYPE_TASK, task.getId(), task.getTitle(), null, null,
                    Boolean.TRUE.equals(task.getAllDay()), null, null,
                    task.getDueAt(), task.getStatus(), task.getPriority(), null, null,
                    null, null, null));
        }
        return items;
    }

    /**
     * 我绑定过的所有组织下发给我的组织日程。
     *
     * <p>这些日程是只读的：结果带 `identityId` / `orgId` / `orgName`，
     * App 点开时切到对应组织视图，而不是打开个人日程编辑页。
     */
    private List<SearchResultItem> searchOrgEvents(Long accountId, String pattern, int limit) {
        List<OrgEventHit> hits = searchMapper.searchOrgEvents(accountId, pattern, limit);
        if (hits.isEmpty()) {
            return List.of();
        }
        // 同一个日程可能被多次下发给我，按事件去重（保留第一次命中的身份/组织）
        Map<Long, IdentityRef> refs = new LinkedHashMap<>();
        for (OrgEventHit hit : hits) {
            refs.putIfAbsent(hit.getEventId(),
                    new IdentityRef(hit.getIdentityId(), hit.getOrgId(), hit.getOrgName()));
        }

        List<Event> events = eventMapper.selectBatchIds(refs.keySet()).stream()
                .filter(event -> event.getDeletedAt() == null)
                .filter(event -> !Event.STATUS_CANCELLED.equals(event.getStatus()))
                .toList();
        if (events.isEmpty()) {
            return List.of();
        }
        Map<Long, List<EventException>> exceptionsByEvent = exceptionsFor(
                events.stream().map(Event::getId).toList());

        Instant now = Instant.now();
        List<SearchResultItem> items = new ArrayList<>(events.size());
        for (Event event : events) {
            IdentityRef ref = refs.get(event.getId());
            Occurrence occurrence = resolveOccurrence(
                    event, exceptionsByEvent.getOrDefault(event.getId(), List.of()), now);
            items.add(new SearchResultItem(
                    TYPE_ORG_EVENT, event.getId(), event.getTitle(),
                    occurrence.start(), occurrence.end(),
                    Boolean.TRUE.equals(event.getAllDay()),
                    StringUtils.hasText(event.getTimezone()) ? event.getTimezone() : "UTC",
                    event.getLocationName(), null,
                    event.getStatus(), event.getPriority(),
                    StringUtils.hasText(event.getRrule()), occurrence.occurrenceDate(),
                    ref.identityId(), ref.orgId(), ref.orgName()));
        }
        return items;
    }

    /** 批量取重复例外：逐条查就是 N+1。 */
    private Map<Long, List<EventException>> exceptionsFor(List<Long> eventIds) {
        if (eventIds.isEmpty()) {
            return Map.of();
        }
        return eventExceptionMapper.selectList(new LambdaQueryWrapper<EventException>()
                        .in(EventException::getEventId, eventIds))
                .stream()
                .collect(Collectors.groupingBy(EventException::getEventId));
    }

    /**
     * 命中时间：重复日程给出**最近一次实例**，非重复就用自己的起止时间。
     *
     * <p>序列已经走完（rrule_until 已过）时退回序列起点、occurrenceDate 留空，
     * 让 App 打开整条序列而不是某个不存在的实例。
     */
    private Occurrence resolveOccurrence(Event event, List<EventException> exceptions, Instant now) {
        ZoneId zone = resolveZone(event.getTimezone());
        if (!StringUtils.hasText(event.getRrule())) {
            return new Occurrence(event.getStartAt(), event.getEndAt(), null);
        }
        List<EventOccurrence> upcoming =
                expander.expand(event, exceptions, now, now.plus(NEXT_OCCURRENCE_WINDOW));
        if (upcoming.isEmpty()) {
            return new Occurrence(event.getStartAt(), event.getEndAt(), null);
        }
        EventOccurrence next = upcoming.getFirst();
        return new Occurrence(
                OffsetDateTime.ofInstant(next.startAt(), zone),
                OffsetDateTime.ofInstant(next.endAt(), zone),
                next.occurrenceDate());
    }

    /** 排序时刻：日程取开始时间，待办取截止时间；都没有则为 null（排最后）。 */
    private static Instant sortInstant(SearchResultItem item) {
        OffsetDateTime at = TYPE_TASK.equals(item.type()) ? item.dueAt() : item.startAt();
        return at == null ? null : at.toInstant();
    }

    private static Set<String> parseTypes(List<String> types) {
        if (types == null || types.isEmpty()) {
            return ALL_TYPES;
        }
        Set<String> result = new HashSet<>();
        for (String raw : types) {
            for (String part : raw.split(",")) {
                String value = part.trim().toUpperCase(Locale.ROOT);
                if (value.isEmpty()) {
                    continue;
                }
                if (!ALL_TYPES.contains(value)) {
                    throw BizException.of(ErrorCode.PARAM_INVALID, "types 取值非法: " + part.trim());
                }
                result.add(value);
            }
        }
        return result.isEmpty() ? ALL_TYPES : result;
    }

    /** 关键字 → LIKE 模式串（转义规则见 {@link LikeQuery}，与「全部日程」共用一份）。 */
    private static String likePattern(String keyword) {
        return LikeQuery.pattern(keyword);
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

    private record Occurrence(OffsetDateTime start, OffsetDateTime end, LocalDate occurrenceDate) {
    }

    private record IdentityRef(Long identityId, Long orgId, String orgName) {
    }
}
