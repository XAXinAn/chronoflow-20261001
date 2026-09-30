package com.xatodo.agent.tool;

import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.EventOccurrence;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.mapper.EventMapper;
import com.xatodo.personal.service.EventService;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 助手能看到的日程：**只有当前用户自己的个人日程**（spec §11 阶段三）。
 *
 * <p>这是助手的「隔离沙盒」入口，四个工具全部从这里读、从这里校验归属：
 * 查询按 {@code personalIdentityId} 收敛（日历归属由 {@link EventService} 再校验一层），
 * 写入前也必须先过这条路径拿到 id。**组织下发的日程不在范围内**——
 * 组织日程的只读/下发留给下一阶段新增的独立工具。
 */
@Service
public class AgentVisibleEvents {

    /** 列表里备注只给这么长的预览：整段备注可能几千字，全塞进上下文既贵又没用。 */
    public static final int NOTE_PREVIEW_LIMIT = 60;

    private final EventService eventService;
    private final EventMapper eventMapper;

    public AgentVisibleEvents(EventService eventService, EventMapper eventMapper) {
        this.eventService = eventService;
        this.eventMapper = eventMapper;
    }

    /**
     * 按时间范围查当前用户的个人日程（重复日程按实例展开），按时间**正序**。
     *
     * <p>时间范围是**必填**：助手必须知道自己要看哪一段，才谈得上"缩小范围"。
     * 关键词可选，匹配**标题 / 地点 / 备注**（与 App 检索口径一致）。
     */
    public List<VisibleEvent> listPersonal(Long personalIdentityId, String keyword,
                                           Instant from, Instant to) {
        if (from == null || to == null) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "查询窗口 from 与 to 都必须给");
        }
        if (!from.isBefore(to)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "to 必须晚于 from");
        }
        List<EventOccurrence> occurrences =
                eventService.rangeQuery(personalIdentityId, null, from, to);
        if (occurrences.isEmpty()) {
            return List.of();
        }

        // 备注预览与关键词匹配都要看备注，所以这里统一把日程实体取一次
        Map<Long, Event> eventsById = loadEvents(occurrences);
        Map<Long, String> searchable = StringUtils.hasText(keyword)
                ? searchableText(eventsById)
                : Map.of();
        String needle = keyword == null ? "" : keyword.trim().toLowerCase(Locale.ROOT);

        List<VisibleEvent> result = new ArrayList<>();
        for (EventOccurrence occurrence : occurrences) {
            if (!needle.isEmpty() && !searchable.getOrDefault(occurrence.eventId(), "")
                    .contains(needle)) {
                continue;
            }
            Event event = eventsById.get(occurrence.eventId());
            String note = event == null || event.getDescription() == null
                    ? ""
                    : event.getDescription();
            result.add(new VisibleEvent(
                    occurrence.eventId(),
                    occurrence.title(),
                    occurrence.at(),
                    occurrence.locationName(),
                    occurrence.locationDetail(),
                    note.isBlank() ? null : preview(note),
                    note.length(),
                    occurrence.recurring(),
                    occurrence.occurrenceDate()));
        }
        result.sort(Comparator.comparing(VisibleEvent::at).thenComparing(VisibleEvent::eventId));
        return result;
    }

    /**
     * 这个 id 是不是当前用户自己的个人日程。
     *
     * <p>改 / 删都要先问这一句：**不属于自己的日程一律当"找不到"**，
     * 既不泄露"它存在"，也不给越权的机会。
     */
    public boolean isOwnedPersonalEvent(Long personalIdentityId, long eventId) {
        try {
            eventService.requireOwned(personalIdentityId, eventId);
            return true;
        } catch (BizException ex) {
            return false;
        }
    }

    private Map<Long, Event> loadEvents(List<EventOccurrence> occurrences) {
        List<Long> ids = occurrences.stream().map(EventOccurrence::eventId).distinct().toList();
        Map<Long, Event> events = new HashMap<>();
        for (Event event : eventMapper.selectBatchIds(ids)) {
            events.put(event.getId(), event);
        }
        return events;
    }

    /** 命中关键词用的小写文本：标题 + 地点 + 详细地址 + 备注。 */
    private static Map<Long, String> searchableText(Map<Long, Event> eventsById) {
        Map<Long, String> text = new HashMap<>();
        for (Event event : eventsById.values()) {
            text.put(event.getId(), String.join(" ",
                    nullToEmpty(event.getTitle()),
                    nullToEmpty(event.getLocationName()),
                    nullToEmpty(event.getLocationAddress()),
                    nullToEmpty(event.getLocationDetail()),
                    nullToEmpty(event.getDescription()))
                    .toLowerCase(Locale.ROOT));
        }
        return text;
    }

    /** 备注预览：截断到固定长度并加省略号，全文要用 read_my_event_note 分段读。 */
    public static String preview(String note) {
        String trimmed = note.strip();
        if (trimmed.length() <= NOTE_PREVIEW_LIMIT) {
            return trimmed;
        }
        return trimmed.substring(0, NOTE_PREVIEW_LIMIT) + "…";
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
