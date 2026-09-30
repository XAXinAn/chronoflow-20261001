package com.xatodo.agent.tool;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.xatodo.agent.dto.AgentAction;
import com.xatodo.agent.model.AgentToolCall;
import com.xatodo.agent.model.AgentToolSpec;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.geo.GeoPlace;
import com.xatodo.personal.geo.GeoService;
import com.xatodo.personal.service.EventService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 助手能调用的工具（spec §11 阶段三）。
 *
 * <p>只有四个，而且四个都只碰「当前用户自己的个人日程」：
 * list_my_events 按时间范围查（时间必填，直接执行、不出授权）；
 * create_my_event / update_my_event / delete_my_event 只产出「待授权」动作，
 * 用户点了「允许」之后才由 App 调既有 REST 真正写入。
 *
 * <p>名字里的 my_ 前缀是刻意的：组织日程将来以**新工具**的形式加进来
 * （例如 list_org_events），而不是把这四个改造成"既能个人又能组织"，
 * 那正是越权最容易发生的地方。所有查询与写入都经 AgentVisibleEvents 收敛到
 * 当前账号的个人身份上，他人的日程一律当"找不到"。
 *
 * <p>每个工具除了给模型的结果（json），还会产出一行**给用户看的** ToolRow
 * （摘要 + 可展开明细），让"它到底做了什么"在对话里看得见。
 */
@Service
public class AgentToolRegistry {

    private static final Logger log = LoggerFactory.getLogger(AgentToolRegistry.class);

    public static final String LIST_MY_EVENTS = "list_my_events";
    public static final String READ_MY_EVENT_NOTE = "read_my_event_note";
    public static final String CREATE_MY_EVENT = "create_my_event";
    public static final String UPDATE_MY_EVENT = "update_my_event";
    public static final String DELETE_MY_EVENT = "delete_my_event";

    /** 给模型的日程条数上限。超过就只回一句"太多了，缩小范围"。 */
    private static final int EVENT_LIMIT = 20;
    /** 一行工具记录最多展开几条明细。 */
    private static final int DETAIL_LIMIT = 3;
    /** 单次读备注的**硬上限**：备注可能几千字，一次全塞进上下文既贵又没用。 */
    private static final int NOTE_READ_MAX = 500;

    private final ObjectMapper objectMapper;
    private final AgentVisibleEvents visibleEvents;
    private final EventService eventService;
    private final GeoService geoService;

    public AgentToolRegistry(ObjectMapper objectMapper,
                             AgentVisibleEvents visibleEvents,
                             EventService eventService,
                             GeoService geoService) {
        this.objectMapper = objectMapper;
        this.visibleEvents = visibleEvents;
        this.eventService = eventService;
        this.geoService = geoService;
    }

    /**
     * 一次工具调用的结果。
     *
     * @param json   回灌给模型的工具结果（紧凑 JSON）
     * @param action 写操作产出的待授权动作；查询类为 null
     * @param row    给用户看的一行（摘要 + 明细）
     */
    public record ToolOutcome(String json, AgentAction action, ToolRow row) {

        static ToolOutcome read(String json, ToolRow row) {
            return new ToolOutcome(json, null, row);
        }

        static ToolOutcome write(String json, AgentAction action, ToolRow row) {
            return new ToolOutcome(json, action, row);
        }

        static ToolOutcome failed(String reason) {
            ObjectNode node = new ObjectMapper().createObjectNode();
            node.put("error", reason);
            return new ToolOutcome(node.toString(), null,
                    new ToolRow(true, "这次没成", List.of(reason)));
        }
    }

    /**
     * 给用户看的一行工具记录。
     *
     * @param readOnly 查询类（只读）为 true；写操作为 false
     */
    public record ToolRow(boolean readOnly, String summary, List<String> detail) {
    }

    /** 这个工具是不是查询类（只读）：服务端据此决定"并行执行"还是"申请授权后停下"。 */
    public boolean isReadOnly(String toolName) {
        return LIST_MY_EVENTS.equals(toolName) || READ_MY_EVENT_NOTE.equals(toolName);
    }

    public List<AgentToolSpec> specs() {
        return List.of(listSpec(), readNoteSpec(), createSpec(), updateSpec(), deleteSpec());
    }

    private AgentToolSpec listSpec() {
        return new AgentToolSpec(LIST_MY_EVENTS,
                "查当前用户**自己的个人日程**（不含组织下发的）。"
                        + "日程**只有一个时间点**（字段 at），没有开始 / 结束之分。"
                        + "from 与 to 是**查询窗口**，都必填；不知道范围时先用一个合理窗口"
                        + "（例如今天起未来 30 天）再逐步收窄。"
                        + "结果超过 " + EVENT_LIMIT + " 条时不会给数据，只回一句「太多了」，"
                        + "这时要用更小的窗口重新调用。",
                schema(List.of("from", "to"), properties -> {
                    properties.putObject("from").put("type", "string")
                            .put("description", "查询窗口起点，ISO 8601 带时区，必填");
                    properties.putObject("to").put("type", "string")
                            .put("description", "查询窗口终点（不含），ISO 8601 带时区，必填");
                    properties.putObject("keyword").put("type", "string")
                            .put("description", "标题 / 地点 / 备注关键字，可选");
                }));
    }

    /**
     * 读某条日程的**备注全文**（分段）。
     *
     * <p>为什么单独一个工具：列表里备注只给 60 字预览，超长备注一进上下文就又把成本顶回去了。
     * 这里要求显式给 offset 与 length，服务端再把 length 夹到 {@link #NOTE_READ_MAX}，
     * 模型要看全文就自己翻页。
     */
    private AgentToolSpec readNoteSpec() {
        return new AgentToolSpec(READ_MY_EVENT_NOTE,
                "读某条**个人日程**的备注全文，必须给范围：offset（从第几个字开始，从 0 起）"
                        + "与 length（这次要读多少字，最多 " + NOTE_READ_MAX + " 字，服务端会夹到上限）。"
                        + "返回里带 total（备注总字数）与 hasMore，需要全文就按 offset 继续翻。"
                        + "列表里的备注只是 " + AgentVisibleEvents.NOTE_PREVIEW_LIMIT + " 字预览，"
                        + "用户问备注细节时用它。",
                schema(List.of("eventId", "offset", "length"), properties -> {
                    properties.putObject("eventId").put("type", "integer")
                            .put("description", LIST_MY_EVENTS + " 返回的 id");
                    properties.putObject("offset").put("type", "integer")
                            .put("description", "起始位置（0 起）");
                    properties.putObject("length").put("type", "integer")
                            .put("description", "本次读取字数，最大 " + NOTE_READ_MAX);
                }));
    }

    private AgentToolSpec createSpec() {
        return new AgentToolSpec(CREATE_MY_EVENT,
                "为用户创建一条**个人**日程。调用它不会立刻创建："
                        + "服务端会向用户申请一次授权，用户允许后才真正写入。"
                        + "日程**只有一个时间点**：用户说几点就填几点，不要自己编时长。"
                        + "用户明说「一整天」「就那一天」「全天」这类、没有具体几点时，就填**那天 00:00**"
                        + "（当天 00:00 表示「就这一天」）；用户压根没提时间就先问一句几点。"
                        + "缺标题就先问清楚。",
                schema(List.of("title", "at"), properties -> {
                    properties.putObject("title").put("type", "string").put("description", "日程标题");
                    properties.putObject("at").put("type", "string")
                            .put("description", "日程时间，ISO 8601 带时区");
                    properties.putObject("locationName").put("type", "string")
                            .put("description", "地点的文字（例如「西湖」「会议室A」）；"
                                    + "服务端会试着匹配地图地点，匹配不到就放进详细地址");
                    properties.putObject("description").put("type", "string")
                            .put("description", "备注，可选");
                }));
    }

    private AgentToolSpec updateSpec() {
        return new AgentToolSpec(UPDATE_MY_EVENT,
                "修改**当前用户自己的个人日程**（改标题 / 时间 / 地点 / 备注）。"
                        + "调用前先用 " + LIST_MY_EVENTS + " 找到那条日程的 id；"
                        + "只填空需要改的字段，其余留空表示不动。同样要用户授权后才生效。",
                schema(List.of("eventId"), properties -> {
                    properties.putObject("eventId").put("type", "integer")
                            .put("description", LIST_MY_EVENTS + " 返回的 id");
                    properties.putObject("title").put("type", "string").put("description", "新的标题，不改就留空");
                    properties.putObject("at").put("type", "string").put("description", "新的时间，不改就留空");
                    properties.putObject("locationName").put("type", "string")
                            .put("description", "地点文字，不改就留空；传空字符串表示清空地点");
                    properties.putObject("description").put("type", "string").put("description", "备注，不改就留空");
                }));
    }

    private AgentToolSpec deleteSpec() {
        return new AgentToolSpec(DELETE_MY_EVENT,
                "删除**当前用户自己的个人日程**。调用前先用 " + LIST_MY_EVENTS + " 找到它。"
                        + "同样要用户授权后才生效；组织下发的日程不在这个工具的范围内。",
                schema(List.of("eventId"), properties ->
                        properties.putObject("eventId").put("type", "integer")
                                .put("description", LIST_MY_EVENTS + " 返回的 id")));
    }

    private ObjectNode schema(List<String> required, java.util.function.Consumer<ObjectNode> filler) {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        ObjectNode properties = schema.putObject("properties");
        filler.accept(properties);
        ArrayNode requiredNode = schema.putArray("required");
        required.forEach(requiredNode::add);
        return schema;
    }

    /**
     * 执行一次工具调用。
     *
     * @param actionId 写操作用的动作 id（由调用方按顺序生成）
     */
    public ToolOutcome invoke(AgentScope scope, AgentToolCall call, String actionId,
                              Instant now, ZoneId zone) {
        JsonNode args;
        try {
            String raw = call.arguments();
            args = raw == null || raw.isBlank()
                    ? objectMapper.createObjectNode()
                    : objectMapper.readTree(raw);
        } catch (Exception ex) {
            return ToolOutcome.failed("参数不是合法 JSON，请重新调用并给出合法参数");
        }
        return switch (call.name() == null ? "" : call.name()) {
            case LIST_MY_EVENTS -> listEvents(scope, args, zone);
            case READ_MY_EVENT_NOTE -> readNote(scope, args, zone);
            case CREATE_MY_EVENT -> createEvent(args, actionId, zone);
            case UPDATE_MY_EVENT -> updateEvent(scope, args, actionId, zone);
            case DELETE_MY_EVENT -> deleteEvent(scope, args, actionId, zone);
            default -> ToolOutcome.failed("不支持的工具：" + call.name());
        };
    }

    /**
     * 分段读备注：offset + length 都必填，服务端把 length 夹到 {@link #NOTE_READ_MAX}。
     *
     * <p>这样"备注很长"这件事永远不会把上下文顶爆：要看全文就多次调用、自己翻页。
     */
    private ToolOutcome readNote(AgentScope scope, JsonNode args, ZoneId zone) {
        if (!args.path("eventId").canConvertToLong()) {
            return ToolOutcome.failed("缺少 eventId，请先用 " + LIST_MY_EVENTS + " 找到那条日程");
        }
        int offset = args.path("offset").asInt(-1);
        int length = args.path("length").asInt(-1);
        if (offset < 0 || length <= 0) {
            return ToolOutcome.failed("要读备注必须给 offset（0 起）与 length（1.."
                    + NOTE_READ_MAX + "）");
        }
        long eventId = args.path("eventId").asLong();
        if (!visibleEvents.isOwnedPersonalEvent(scope.personalIdentityId(), eventId)) {
            return ToolOutcome.failed("找不到这条日程，它可能不在你的个人日程里");
        }
        Event event = eventService.requireOwned(scope.personalIdentityId(), eventId);
        String note = event.getDescription() == null ? "" : event.getDescription();
        int total = note.length();
        int effectiveLength = Math.min(length, NOTE_READ_MAX);
        int from = Math.min(offset, total);
        int to = Math.min(from + effectiveLength, total);
        String slice = note.substring(from, to);

        ObjectNode root = objectMapper.createObjectNode();
        root.put("eventId", eventId);
        root.put("title", event.getTitle());
        root.put("total", total);
        root.put("offset", from);
        root.put("length", slice.length());
        root.put("maxLength", NOTE_READ_MAX);
        root.put("hasMore", to < total);
        root.put("text", slice);
        String summary = total == 0
                ? "已读备注 · 这条没有备注"
                : "已读备注 · " + from + "-" + to + " / 共 " + total + " 字";
        List<String> detail = slice.isBlank() ? List.of() : List.of(
                slice.length() > AgentVisibleEvents.NOTE_PREVIEW_LIMIT
                        ? slice.substring(0, AgentVisibleEvents.NOTE_PREVIEW_LIMIT) + "…"
                        : slice);
        return ToolOutcome.read(root.toString(), new ToolRow(true, summary, detail));
    }

    // ------------------------------------------------------------- 查询（只读）

    private ToolOutcome listEvents(AgentScope scope, JsonNode args, ZoneId zone) {
        Instant start = AgentTimes.parse(text(args, "from"), zone);
        Instant end = AgentTimes.parse(text(args, "to"), zone);
        if (start == null || end == null) {
            return ToolOutcome.failed("需要 from 与 to（ISO 8601 带时区）作为查询窗口，请先向用户确认");
        }

        List<VisibleEvent> events;
        try {
            events = visibleEvents.listPersonal(
                    scope.personalIdentityId(), text(args, "keyword"), start, end);
        } catch (com.xatodo.common.exception.BizException ex) {
            return ToolOutcome.failed(ex.getMessage());
        }

        // 超过上限就**不给数据**：给半截列表会让模型说出"就这些"，比不答更糟
        if (events.size() > EVENT_LIMIT) {
            String hint = "结果超过 " + EVENT_LIMIT + " 条，请先缩小时间范围（例如限定到某一天或几天）再查";
            ObjectNode tooMany = objectMapper.createObjectNode();
            tooMany.put("tooMany", true);
            tooMany.put("total", events.size());
            tooMany.put("hint", hint);
            return ToolOutcome.read(tooMany.toString(),
                    new ToolRow(true, "日程较多（共 " + events.size() + " 条）", List.of(hint)));
        }

        ObjectNode root = objectMapper.createObjectNode();
        ArrayNode items = root.putArray("events");
        List<String> detail = new ArrayList<>();
        String keyword = text(args, "keyword");
        if (StringUtils.hasText(keyword)) {
            detail.add("关键词「" + keyword.trim() + "」");
        }
        for (VisibleEvent event : events) {
            ObjectNode node = items.addObject();
            node.put("id", event.eventId());
            node.put("title", event.title());
            node.put("at", iso(event.at(), zone));
            if (event.locationName() != null) {
                node.put("location", event.locationName());
            } else if (event.locationDetail() != null) {
                node.put("locationDetail", event.locationDetail());
            }
            // 备注只给预览（固定长度）：全文要用 read_my_event_note 分段读
            if (event.notePreview() != null) {
                node.put("notePreview", event.notePreview());
                node.put("noteLength", event.noteLength());
            }
            node.put("recurring", event.recurring());
            if (event.occurrenceDate() != null) {
                node.put("occurrenceDate", event.occurrenceDate().toString());
            }
            if (detail.size() <= DETAIL_LIMIT) {
                detail.add(describe(event, zone));
            }
        }
        root.put("total", events.size());
        if (events.isEmpty()) {
            root.put("note", "这个时间范围内没有日程");
        }
        String summary = events.isEmpty() ? "已查日程 · 没有安排" : "已查日程 · " + events.size() + " 条";
        return ToolOutcome.read(root.toString(), new ToolRow(true, summary, List.copyOf(detail)));
    }

    // ------------------------------------------------------- 写操作（待用户授权）

    private ToolOutcome createEvent(JsonNode args, String actionId, ZoneId zone) {
        String title = text(args, "title");
        Instant at = AgentTimes.parse(text(args, "at"), zone);
        if (!StringUtils.hasText(title) || at == null) {
            return ToolOutcome.failed("还缺日程标题或时间，请先向用户确认后再调用");
        }
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("title", title.trim());
        payload.put("at", iso(at, zone));
        applyLocation(payload, text(args, "locationName"));
        if (StringUtils.hasText(text(args, "description"))) {
            payload.put("description", text(args, "description").trim());
        }

        String summary = "创建日程：" + title.trim() + " "
                + AgentTimes.formatPoint(at, zone);
        return ToolOutcome.write(
                pendingJson(actionId, CREATE_MY_EVENT),
                new AgentAction(actionId, AgentAction.TYPE_CREATE_EVENT, summary, payload),
                new ToolRow(false, "已申请创建", List.of(summary)));
    }

    private ToolOutcome deleteEvent(AgentScope scope, JsonNode args, String actionId, ZoneId zone) {
        if (!args.path("eventId").canConvertToLong()) {
            return ToolOutcome.failed("缺少 eventId，请先用 " + LIST_MY_EVENTS + " 找到要删的那条日程");
        }
        long eventId = args.path("eventId").asLong();
        if (!visibleEvents.isOwnedPersonalEvent(scope.personalIdentityId(), eventId)) {
            // 不区分"别人的日程"与"不存在的日程"：都不该让助手确认存在性
            return ToolOutcome.failed("找不到这条日程，它可能不在你的个人日程里");
        }
        Event event = eventService.requireOwned(scope.personalIdentityId(), eventId);

        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("eventId", eventId);
        payload.put("title", event.getTitle());
        payload.put("at", iso(event.getAt().toInstant(), zone));
        payload.put("recurring", StringUtils.hasText(event.getRrule()));
        if (StringUtils.hasText(event.getLocationName())) {
            payload.put("locationName", event.getLocationName());
        }
        if (StringUtils.hasText(event.getLocationDetail())) {
            payload.put("locationDetail", event.getLocationDetail());
        }

        String summary = "删除日程：" + event.getTitle() + " "
                + AgentTimes.formatPoint(event.getAt().toInstant(), zone);
        return ToolOutcome.write(
                pendingJson(actionId, DELETE_MY_EVENT),
                new AgentAction(actionId, AgentAction.TYPE_DELETE_EVENT, summary, payload),
                new ToolRow(false, "已申请删除", List.of(summary)));
    }

    private ToolOutcome updateEvent(AgentScope scope, JsonNode args, String actionId, ZoneId zone) {
        if (!args.path("eventId").canConvertToLong()) {
            return ToolOutcome.failed("缺少 eventId，请先用 " + LIST_MY_EVENTS + " 找到要改的那条日程");
        }
        long eventId = args.path("eventId").asLong();
        if (!visibleEvents.isOwnedPersonalEvent(scope.personalIdentityId(), eventId)) {
            return ToolOutcome.failed("找不到这条日程，它可能不在你的个人日程里");
        }
        Event event = eventService.requireOwned(scope.personalIdentityId(), eventId);

        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("eventId", eventId);
        ObjectNode previous = payload.putObject("previous");
        previous.put("title", event.getTitle());
        previous.put("at", iso(event.getAt().toInstant(), zone));
        if (StringUtils.hasText(event.getLocationName())) {
            previous.put("locationName", event.getLocationName());
        }
        payload.put("recurring", StringUtils.hasText(event.getRrule()));

        List<String> changes = new ArrayList<>();
        String title = text(args, "title");
        if (StringUtils.hasText(title)) {
            payload.put("title", title.trim());
            changes.add("标题改为「" + title.trim() + "」");
        }
        Instant at = AgentTimes.parse(text(args, "at"), zone);
        if (at != null) {
            payload.put("at", iso(at, zone));
            changes.add("时间改为 " + AgentTimes.formatPoint(at, zone));
        }
        if (args.has("locationName")) {
            String locationText = args.path("locationName").asText("");
            if (locationText.isBlank()) {
                payload.putNull("locationName");
                payload.putNull("locationDetail");
                changes.add("清空地点");
            } else {
                applyLocation(payload, locationText);
                changes.add("地点改为「" + locationText.trim() + "」");
            }
        }
        if (args.has("description")) {
            payload.put("description", args.path("description").asText(""));
            changes.add("备注已更新");
        }

        if (changes.isEmpty()) {
            return ToolOutcome.failed("没有给出要修改的字段，请先问清用户要改什么");
        }
        String summary = "修改日程：" + event.getTitle() + " → " + String.join("，", changes);
        return ToolOutcome.write(
                pendingJson(actionId, UPDATE_MY_EVENT),
                new AgentAction(actionId, AgentAction.TYPE_UPDATE_EVENT, summary, payload),
                new ToolRow(false, "已申请修改", List.of(summary)));
    }

    // --------------------------------------------------------------- 内部工具

    /**
     * 地点分两层（spec §5.9）：地图上的地点（名称 + 地址 + 坐标）与手写的详细地址。
     *
     * <p>「会议室A」「3 号楼 305」这类地图上根本没有的名字只能落在详细地址；
     * 早期版本把它写进 locationName，界面上就出现一个导航不了的假地点（实测被用户抓到）。
     */
    private void applyLocation(ObjectNode payload, String locationText) {
        if (!StringUtils.hasText(locationText)) {
            return;
        }
        GeoPlace place = resolvePlace(locationText);
        if (place == null) {
            payload.put("locationDetail", locationText.trim());
            return;
        }
        payload.put("locationName", place.name());
        if (StringUtils.hasText(place.address())) {
            payload.put("locationAddress", place.address());
        }
        if (place.latitude() != null) {
            payload.put("latitude", place.latitude());
        }
        if (place.longitude() != null) {
            payload.put("longitude", place.longitude());
        }
        if (StringUtils.hasText(place.poiId())) {
            payload.put("poiId", place.poiId());
        }
    }

    /**
     * 把用户说的地点文字匹配成地图上的地点（破坏性最小的保守匹配）。
     *
     * <p>只有结果名与用户说的基本一致（去空格标点后互相包含）才认；
     * 宁可不给坐标，也不要给错坐标——用户点「导航」跑错地方比看到一句「3 号楼 305」糟得多。
     */
    private GeoPlace resolvePlace(String text) {
        try {
            for (GeoPlace place : geoService.searchPlaces(text.trim(), null, null, null, 5)) {
                if (samePlace(text, place.name())) {
                    return place;
                }
            }
        } catch (Exception ex) {
            log.debug("助手地点解析失败，退化为详细地址: {}", ex.getMessage());
        }
        return null;
    }

    private static boolean samePlace(String spoken, String placeName) {
        if (placeName == null) {
            return false;
        }
        String a = normalizePlace(spoken);
        String b = normalizePlace(placeName);
        return !a.isEmpty() && (a.equals(b) || b.contains(a) || a.contains(b));
    }

    private static String normalizePlace(String value) {
        return value == null
                ? ""
                : value.toLowerCase(Locale.ROOT).replaceAll("[\\s\\p{Punct}·（）()【】\\[\\]]", "");
    }

    private static String describe(VisibleEvent event, ZoneId zone) {
        StringBuilder line = new StringBuilder(event.title()).append(" · ")
                .append(AgentTimes.formatPoint(event.at(), zone));
        String place = event.locationName() != null ? event.locationName() : event.locationDetail();
        if (StringUtils.hasText(place)) {
            line.append(" · ").append(place);
        }
        if (event.recurring()) {
            line.append("（重复）");
        }
        return line.toString();
    }

    private String pendingJson(String actionId, String type) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("status", "pending_authorization");
        node.put("actionId", actionId);
        node.put("type", type);
        node.put("note", "已向用户申请授权；用户在界面上点「允许」后才真正写入。"
                + "不要再重复调用这个工具，也不要在这条结果之后再执行别的操作。");
        return node.toString();
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        String raw = value.isValueNode() ? value.asText("") : "";
        return raw.isBlank() ? null : raw;
    }

    /** 给模型看的时间：带偏移量，原样带回时不会歧义。 */
    private static String iso(Instant instant, ZoneId zone) {
        return java.time.OffsetDateTime.ofInstant(instant, zone).toString();
    }
}
