package com.xatodo.agent.permission;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.xatodo.agent.dto.AgentAction;
import com.xatodo.agent.tool.AgentTimes;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.personal.dto.PersonalDtos.EventCreateRequest;
import com.xatodo.personal.dto.PersonalDtos.EventUpdateRequest;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.service.EventService;
import com.xatodo.personal.dto.PersonalDtos.EventScope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;

/**
 * 摘要通过之后**真正执行**写操作（对照 mewcode 的 `StreamingExecutor.executeSingle`：
 * 权限通过 → 执行工具 → 把结果作为 tool_result 回灌）。
 *
 * <p>走的是和 REST 完全同一套 `EventService`：隔离沙盒、重复规则、提醒清理一个都不少，
 * 助手不会成为绕开校验的旁路。
 */
@Component
public class AgentWriteExecutor {

    private static final Logger log = LoggerFactory.getLogger(AgentWriteExecutor.class);

    /**
     * @param json    写回模型的工具结果
     * @param summary 给用户看的一句话
     */
    public record WriteOutcome(boolean ok, String json, String summary) {
    }

    private final EventService eventService;
    private final ObjectMapper objectMapper;

    public AgentWriteExecutor(EventService eventService, ObjectMapper objectMapper) {
        this.eventService = eventService;
        this.objectMapper = objectMapper;
    }

    public WriteOutcome execute(Long identityId, AgentAction action, ZoneId zone) {
        if (action == null || action.type() == null) {
            return failed("不知道要执行什么操作");
        }
        try {
            return switch (action.type()) {
                case AgentAction.TYPE_CREATE_EVENT -> create(identityId, action.payload());
                case AgentAction.TYPE_UPDATE_EVENT -> update(identityId, action.payload(), zone);
                case AgentAction.TYPE_DELETE_EVENT -> delete(identityId, action.payload());
                default -> failed("不支持的操作：" + action.type());
            };
        } catch (BizException ex) {
            return failed(ex.getMessage());
        } catch (Exception ex) {
            log.warn("助手写操作失败: {}", ex.getMessage());
            return failed("执行失败，请稍后再试");
        }
    }

    private WriteOutcome create(Long identityId, JsonNode payload) {
        Event event = eventService.create(identityId, new EventCreateRequest(
                null,
                text(payload, "title"),
                text(payload, "description"),
                text(payload, "locationName"),
                text(payload, "locationAddress"),
                text(payload, "locationDetail"),
                decimal(objectMapper, payload, "latitude"),
                decimal(objectMapper, payload, "longitude"),
                text(payload, "poiId"),
                offset(payload, "at"),
                text(payload, "timezone"),
                null, null, null, null, null, null, null, null));
        return ok(event, "已创建日程");
    }

    private WriteOutcome update(Long identityId, JsonNode payload, ZoneId zone) {
        long eventId = payload.path("eventId").asLong();
        EventUpdateRequest request = new EventUpdateRequest(
                text(payload, "title"),
                text(payload, "description"),
                text(payload, "locationName"),
                text(payload, "locationAddress"),
                text(payload, "locationDetail"),
                decimal(objectMapper, payload, "latitude"),
                decimal(objectMapper, payload, "longitude"),
                text(payload, "poiId"),
                offset(payload, "at"),
                text(payload, "timezone"),
                null, null, null, null, null, null, null, null,
                EventScope.ALL, null);
        Event event = eventService.update(identityId, eventId, request);
        return ok(event, "已修改日程");
    }

    private WriteOutcome delete(Long identityId, JsonNode payload) {
        long eventId = payload.path("eventId").asLong();
        Event event = eventService.requireOwned(identityId, eventId);
        String title = event.getTitle();
        Instant at = event.getAt().toInstant();
        eventService.delete(identityId, eventId, EventScope.ALL, null);
        ObjectNode node = objectMapper.createObjectNode();
        node.put("status", "ok");
        node.put("eventId", eventId);
        node.put("deleted", true);
        node.put("title", title);
        node.put("at", AgentTimes.format(at, ZoneId.of("Asia/Shanghai")));
        return new WriteOutcome(true, node.toString(), "已删除日程：" + title);
    }

    private WriteOutcome ok(Event event, String verb) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("status", "ok");
        node.put("eventId", event.getId());
        node.put("title", event.getTitle());
        node.put("at", AgentTimes.format(event.getAt().toInstant(), ZoneId.of(
                event.getTimezone() == null ? "Asia/Shanghai" : event.getTimezone())));
        return new WriteOutcome(true, node.toString(),
                verb + "：" + event.getTitle() + " " + AgentTimes.formatPoint(
                        event.getAt().toInstant(),
                        ZoneId.of(event.getTimezone() == null ? "Asia/Shanghai" : event.getTimezone())));
    }

    private WriteOutcome failed(String reason) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("status", "failed");
        node.put("error", reason == null ? ErrorCode.PARAM_INVALID.getMessage() : reason);
        return new WriteOutcome(false, node.toString(), "这次没成：" + reason);
    }

    private static String text(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        String raw = value.isValueNode() ? value.asText("") : "";
        return raw.isBlank() ? null : raw;
    }

    private static OffsetDateTime offset(JsonNode node, String field) {
        String raw = text(node, field);
        return raw == null ? null : OffsetDateTime.parse(raw);
    }

    private static java.math.BigDecimal decimal(ObjectMapper mapper, JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull() || !value.isNumber()) {
            return null;
        }
        return value.decimalValue();
    }
}
