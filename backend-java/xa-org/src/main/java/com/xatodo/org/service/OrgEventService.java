package com.xatodo.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.dto.OrgDtos.OrgEventDispatchRequest;
import com.xatodo.org.dto.OrgDtos.OrgEventResponse;
import com.xatodo.org.dto.OrgDtos.ReceiptItem;
import com.xatodo.org.dto.OrgDtos.ReceiptRequest;
import com.xatodo.org.dto.OrgDtos.ReceiptSummaryResponse;
import com.xatodo.org.entity.Department;
import com.xatodo.org.entity.EventDispatch;
import com.xatodo.org.entity.EventRecipient;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.entity.Organization;
import com.xatodo.org.mapper.EventDispatchMapper;
import com.xatodo.org.mapper.EventRecipientMapper;
import com.xatodo.org.mapper.OrgMemberMapper;
import com.xatodo.org.mapper.OrganizationMapper;
import com.xatodo.personal.dto.EventOccurrence;
import com.xatodo.personal.entity.Calendar;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.entity.EventException;
import com.xatodo.personal.mapper.CalendarMapper;
import com.xatodo.personal.mapper.EventExceptionMapper;
import com.xatodo.personal.mapper.EventMapper;
import com.xatodo.personal.recurrence.RecurrenceExpander;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 组织日历：管理员创建日程并按「全员 / 部门 / 指定成员」下发，成员只读并可提交回执（spec §4.2.2）。
 *
 * <p>下发时按下发范围**快照展开**到成员级别（{@code event_recipient}），
 * 因此后续新入组成员不会补收历史日程（spec §10.1 必测场景 5）。
 */
@Service
public class OrgEventService {

    private static final Set<String> RECEIPT_STATUSES =
            Set.of(EventRecipient.ACCEPTED, EventRecipient.DECLINED, EventRecipient.COMPLETED);

    private final OrgPermissionService permission;
    private final DepartmentService departmentService;
    private final OrgMemberMapper orgMemberMapper;
    private final OrganizationMapper organizationMapper;
    private final EventDispatchMapper eventDispatchMapper;
    private final EventRecipientMapper eventRecipientMapper;
    private final EventMapper eventMapper;
    private final EventExceptionMapper eventExceptionMapper;
    private final CalendarMapper calendarMapper;
    private final RecurrenceExpander expander;

    public OrgEventService(OrgPermissionService permission,
                           DepartmentService departmentService,
                           OrgMemberMapper orgMemberMapper,
                           OrganizationMapper organizationMapper,
                           EventDispatchMapper eventDispatchMapper,
                           EventRecipientMapper eventRecipientMapper,
                           EventMapper eventMapper,
                           EventExceptionMapper eventExceptionMapper,
                           CalendarMapper calendarMapper,
                           RecurrenceExpander expander) {
        this.permission = permission;
        this.departmentService = departmentService;
        this.orgMemberMapper = orgMemberMapper;
        this.organizationMapper = organizationMapper;
        this.eventDispatchMapper = eventDispatchMapper;
        this.eventRecipientMapper = eventRecipientMapper;
        this.eventMapper = eventMapper;
        this.eventExceptionMapper = eventExceptionMapper;
        this.calendarMapper = calendarMapper;
        this.expander = expander;
    }

    // ------------------------------------------------------------------ 下发

    @Transactional
    public OrgEventResponse dispatch(OrgMember actor, OrgEventDispatchRequest request) {
        if (!request.endAt().isAfter(request.startAt())) {
            throw BizException.of(ErrorCode.EVENT_TIME_INVALID);
        }
        expander.validate(request.rrule());
        if (StringUtils.hasText(request.rrule())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "首版组织日程暂不支持重复规则");
        }

        List<OrgMember> recipients = resolveRecipients(actor, request);
        if (recipients.isEmpty()) {
            throw BizException.of(ErrorCode.DISPATCH_TARGET_EMPTY);
        }

        Calendar calendar = ensureOrgCalendar(actor.getOrgId());
        Event event = new Event();
        event.setCalendarId(calendar.getId());
        event.setOrgId(actor.getOrgId());
        event.setCreatorIdentityId(actor.getIdentityId());
        event.setSourceType("ORG_DISPATCH");
        event.setTitle(request.title());
        event.setDescription(request.description());
        event.setLocation(request.location());
        event.setStartAt(request.startAt());
        event.setEndAt(request.endAt());
        event.setAllDay(Boolean.TRUE.equals(request.allDay()));
        event.setTimezone(StringUtils.hasText(request.timezone())
                ? request.timezone()
                : calendar.getTimezone());
        event.setStatus(Event.STATUS_CONFIRMED);
        event.setUpdatedAfterDispatch(false);
        eventMapper.insert(event);

        EventDispatch dispatch = new EventDispatch();
        dispatch.setEventId(event.getId());
        dispatch.setOrgId(actor.getOrgId());
        dispatch.setScopeType(request.scopeType());
        dispatch.setDepartmentId(request.departmentId());
        dispatch.setIncludeSubDepartments(request.includeSubDepartments() == null
                || Boolean.TRUE.equals(request.includeSubDepartments()));
        dispatch.setRequireReceipt(Boolean.TRUE.equals(request.requireReceipt()));
        dispatch.setCreatedByMemberId(actor.getId());
        dispatch.setStatus(EventDispatch.STATUS_ACTIVE);
        dispatch.setRecipientCount(recipients.size());
        eventDispatchMapper.insert(dispatch);

        event.setDispatchId(dispatch.getId());
        eventMapper.updateById(event);

        for (OrgMember recipient : recipients) {
            EventRecipient row = new EventRecipient();
            row.setDispatchId(dispatch.getId());
            row.setEventId(event.getId());
            row.setOrgMemberId(recipient.getId());
            row.setDepartmentId(recipient.getDepartmentId());
            row.setReceiptStatus(EventRecipient.PENDING);
            eventRecipientMapper.insert(row);
        }

        return toResponse(event, dispatch, null);
    }

    /**
     * 撤回下发。已有成员回执时不允许撤回（spec §4.2.2）。
     */
    @Transactional
    public void revoke(OrgMember actor, Long eventId) {
        EventDispatch dispatch = requireActiveDispatch(actor.getOrgId(), eventId);
        requireCanViewDispatch(actor, dispatch);

        Long receipted = eventRecipientMapper.selectCount(new LambdaQueryWrapper<EventRecipient>()
                .eq(EventRecipient::getDispatchId, dispatch.getId())
                .ne(EventRecipient::getReceiptStatus, EventRecipient.PENDING));
        if (receipted != null && receipted > 0) {
            throw BizException.of(ErrorCode.DISPATCH_ALREADY_RECEIPTED);
        }
        dispatch.setStatus(EventDispatch.STATUS_REVOKED);
        eventDispatchMapper.updateById(dispatch);
    }

    // ------------------------------------------------------------ 成员侧读取

    /**
     * 成员视角的组织日程列表：仅返回下发给本人的日程，附带回执状态；重复日程展开为实例。
     */
    public List<OrgEventResponse> listForMember(OrgMember member, Instant rangeStart, Instant rangeEnd) {
        List<EventRecipient> mine = eventRecipientMapper.selectList(
                new LambdaQueryWrapper<EventRecipient>()
                        .eq(EventRecipient::getOrgMemberId, member.getId()));
        if (mine.isEmpty()) {
            return List.of();
        }
        Map<Long, EventRecipient> receiptByEvent = mine.stream()
                .collect(Collectors.toMap(EventRecipient::getEventId, row -> row, (a, b) -> a));

        List<Event> events = eventMapper.selectList(new LambdaQueryWrapper<Event>()
                .in(Event::getId, receiptByEvent.keySet())
                .isNull(Event::getDeletedAt)
                .ne(Event::getStatus, Event.STATUS_CANCELLED));
        if (events.isEmpty()) {
            return List.of();
        }

        Set<Long> activeDispatchIds = eventDispatchMapper.selectList(
                        new LambdaQueryWrapper<EventDispatch>()
                                .in(EventDispatch::getId,
                                        mine.stream().map(EventRecipient::getDispatchId).toList())
                                .eq(EventDispatch::getStatus, EventDispatch.STATUS_ACTIVE))
                .stream().map(EventDispatch::getId).collect(Collectors.toSet());
        Map<Long, EventDispatch> dispatches = eventDispatchMapper.selectList(
                        new LambdaQueryWrapper<EventDispatch>()
                                .in(EventDispatch::getId, activeDispatchIds))
                .stream().collect(Collectors.toMap(EventDispatch::getId, d -> d));

        Map<Long, List<EventException>> exceptions = eventExceptionMapper.selectList(
                        new LambdaQueryWrapper<EventException>()
                                .in(EventException::getEventId, events.stream().map(Event::getId).toList()))
                .stream().collect(Collectors.groupingBy(EventException::getEventId));

        List<OrgEventResponse> result = new ArrayList<>();
        for (Event event : events) {
            EventRecipient receipt = receiptByEvent.get(event.getId());
            EventDispatch dispatch = dispatches.get(receipt.getDispatchId());
            if (dispatch == null) {
                continue;
            }
            for (EventOccurrence occurrence : expander.expand(
                    event, exceptions.getOrDefault(event.getId(), List.of()), rangeStart, rangeEnd)) {
                result.add(new OrgEventResponse(
                        event.getId(), dispatch.getId(), occurrence.title(), event.getDescription(),
                        occurrence.location(),
                        OffsetDateTime.ofInstant(occurrence.startAt(), ZoneOffset.UTC),
                        OffsetDateTime.ofInstant(occurrence.endAt(), ZoneOffset.UTC),
                        occurrence.allDay(), occurrence.timezone(), event.getRrule(),
                        dispatch.getRequireReceipt(), receipt.getReceiptStatus(), receipt.getReceiptAt(),
                        receipt.getRemark(), receipt.getReadAt() != null));
            }
        }
        result.sort(Comparator.comparing(OrgEventResponse::startAt)
                .thenComparing(OrgEventResponse::eventId));
        return result;
    }

    /**
     * 提交回执。成员只能改动属于自己那条收件记录，组织日程本身对成员始终只读。
     */
    @Transactional
    public OrgEventResponse submitReceipt(OrgMember member, Long eventId, ReceiptRequest request) {
        if (!RECEIPT_STATUSES.contains(request.status())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "回执状态取值非法: " + request.status());
        }
        EventRecipient recipient = eventRecipientMapper.selectOne(
                new LambdaQueryWrapper<EventRecipient>()
                        .eq(EventRecipient::getEventId, eventId)
                        .eq(EventRecipient::getOrgMemberId, member.getId()));
        if (recipient == null) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该日程未下发给当前成员");
        }
        EventDispatch dispatch = eventDispatchMapper.selectById(recipient.getDispatchId());
        if (dispatch == null || !EventDispatch.STATUS_ACTIVE.equals(dispatch.getStatus())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该下发已撤回");
        }

        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        recipient.setReceiptStatus(request.status());
        recipient.setReceiptAt(now);
        recipient.setRemark(request.remark());
        recipient.setReadAt(now);
        eventRecipientMapper.updateById(recipient);

        Event event = eventMapper.selectById(eventId);
        return new OrgEventResponse(event.getId(), dispatch.getId(), event.getTitle(),
                event.getDescription(), event.getLocation(), event.getStartAt(), event.getEndAt(),
                event.getAllDay(), event.getTimezone(), event.getRrule(),
                dispatch.getRequireReceipt(), recipient.getReceiptStatus(), recipient.getReceiptAt(),
                recipient.getRemark(), true);
    }

    @Transactional
    public void markRead(OrgMember member, Long eventId) {
        EventRecipient recipient = eventRecipientMapper.selectOne(
                new LambdaQueryWrapper<EventRecipient>()
                        .eq(EventRecipient::getEventId, eventId)
                        .eq(EventRecipient::getOrgMemberId, member.getId()));
        if (recipient == null) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该日程未下发给当前成员");
        }
        if (recipient.getReadAt() == null) {
            recipient.setReadAt(OffsetDateTime.now(ZoneOffset.UTC));
            eventRecipientMapper.updateById(recipient);
        }
    }

    // ------------------------------------------------------------ 管理员侧统计

    public ReceiptSummaryResponse receiptSummary(OrgMember actor, Long eventId) {
        EventDispatch dispatch = requireActiveDispatch(actor.getOrgId(), eventId);
        requireCanViewDispatch(actor, dispatch);

        List<EventRecipient> rows = eventRecipientMapper.selectList(
                new LambdaQueryWrapper<EventRecipient>()
                        .eq(EventRecipient::getDispatchId, dispatch.getId()));
        Map<Long, OrgMember> members = rows.isEmpty() ? Map.of()
                : orgMemberMapper.selectBatchIds(rows.stream().map(EventRecipient::getOrgMemberId).toList())
                .stream().collect(Collectors.toMap(OrgMember::getId, m -> m));
        Map<Long, Department> departments = new HashMap<>();
        permission.allDepartments(actor.getOrgId())
                .forEach(department -> departments.put(department.getId(), department));

        int pending = 0;
        int accepted = 0;
        int declined = 0;
        int completed = 0;
        int readCount = 0;
        List<ReceiptItem> items = new ArrayList<>();
        for (EventRecipient row : rows) {
            switch (row.getReceiptStatus()) {
                case EventRecipient.ACCEPTED -> accepted++;
                case EventRecipient.DECLINED -> declined++;
                case EventRecipient.COMPLETED -> completed++;
                default -> pending++;
            }
            if (row.getReadAt() != null) {
                readCount++;
            }
            OrgMember member = members.get(row.getOrgMemberId());
            Department department = departments.get(row.getDepartmentId());
            items.add(new ReceiptItem(row.getOrgMemberId(),
                    member == null ? null : member.getRealName(),
                    department == null ? null : department.getName(),
                    row.getReceiptStatus(), row.getReceiptAt(), row.getRemark(), row.getReadAt() != null));
        }

        return new ReceiptSummaryResponse(dispatch.getId(), dispatch.getEventId(), dispatch.getScopeType(),
                Boolean.TRUE.equals(dispatch.getRequireReceipt()),
                rows.size(), pending, accepted, declined, completed, readCount, items);
    }

    // ------------------------------------------------------------- 内部实现

    private List<OrgMember> resolveRecipients(OrgMember actor, OrgEventDispatchRequest request) {
        String scope = request.scopeType();
        if (EventDispatch.SCOPE_ALL.equals(scope)) {
            permission.requireOrgAdmin(actor);
            return activeMembers(actor.getOrgId(), null);
        }
        if (EventDispatch.SCOPE_DEPARTMENT.equals(scope)) {
            if (request.departmentId() == null) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "departmentId 不能为空");
            }
            permission.requireCanManageDepartment(actor, request.departmentId());
            Department department = departmentService.requireInOrg(actor.getOrgId(), request.departmentId());
            boolean includeSub = request.includeSubDepartments() == null
                    || Boolean.TRUE.equals(request.includeSubDepartments());
            Set<Long> departmentScope = permission.resolveDepartmentScope(department, includeSub);
            return activeMembers(actor.getOrgId(), departmentScope);
        }
        if (EventDispatch.SCOPE_MEMBER.equals(scope)) {
            if (request.memberIds() == null || request.memberIds().isEmpty()) {
                throw BizException.of(ErrorCode.DISPATCH_TARGET_EMPTY);
            }
            List<OrgMember> targets = orgMemberMapper.selectList(new LambdaQueryWrapper<OrgMember>()
                    .eq(OrgMember::getOrgId, actor.getOrgId())
                    .in(OrgMember::getId, request.memberIds()));
            if (targets.size() != Set.copyOf(request.memberIds()).size()) {
                throw BizException.of(ErrorCode.FORBIDDEN, "下发目标中存在不属于当前组织的成员");
            }
            Set<Long> manageable = permission.manageableDepartmentIds(actor);
            for (OrgMember target : targets) {
                if (!manageable.contains(target.getDepartmentId())) {
                    throw BizException.of(ErrorCode.FORBIDDEN, "无权向该成员下发日程");
                }
            }
            return targets;
        }
        throw BizException.of(ErrorCode.PARAM_INVALID, "下发范围取值非法: " + scope);
    }

    private List<OrgMember> activeMembers(Long orgId, Set<Long> departmentIds) {
        LambdaQueryWrapper<OrgMember> query = new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, orgId)
                .eq(OrgMember::getStatus, OrgMember.STATUS_ACTIVE);
        if (departmentIds != null) {
            query.in(OrgMember::getDepartmentId, departmentIds);
        }
        return orgMemberMapper.selectList(query);
    }

    private void requireCanViewDispatch(OrgMember actor, EventDispatch dispatch) {
        if (permission.isOrgAdmin(actor)) {
            return;
        }
        if (EventDispatch.SCOPE_DEPARTMENT.equals(dispatch.getScopeType())
                && dispatch.getDepartmentId() != null
                && permission.manageableDepartmentIds(actor).contains(dispatch.getDepartmentId())) {
            return;
        }
        throw BizException.of(ErrorCode.FORBIDDEN, "无权查看该下发的回执");
    }

    private EventDispatch requireActiveDispatch(Long orgId, Long eventId) {
        EventDispatch dispatch = eventDispatchMapper.selectOne(new LambdaQueryWrapper<EventDispatch>()
                .eq(EventDispatch::getEventId, eventId)
                .eq(EventDispatch::getOrgId, orgId)
                .eq(EventDispatch::getStatus, EventDispatch.STATUS_ACTIVE)
                .orderByDesc(EventDispatch::getId)
                .last("LIMIT 1"));
        if (dispatch == null) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该日程没有有效的下发记录");
        }
        return dispatch;
    }

    /**
     * 组织日历按需创建，一个组织只有一个组织日历。
     */
    private Calendar ensureOrgCalendar(Long orgId) {
        Calendar existing = calendarMapper.selectOne(new LambdaQueryWrapper<Calendar>()
                .eq(Calendar::getCalendarType, Calendar.TYPE_ORG)
                .eq(Calendar::getOrgId, orgId)
                .eq(Calendar::getStatus, "ACTIVE")
                .last("LIMIT 1"));
        if (existing != null) {
            return existing;
        }
        Organization org = organizationMapper.selectById(orgId);
        Calendar calendar = new Calendar();
        calendar.setCalendarType(Calendar.TYPE_ORG);
        calendar.setOrgId(orgId);
        calendar.setName("组织日历");
        calendar.setColor("#0A0A0A");
        calendar.setTimezone(org == null || org.getTimezone() == null ? "Asia/Shanghai" : org.getTimezone());
        calendar.setIsDefault(true);
        calendar.setStatus("ACTIVE");
        calendarMapper.insert(calendar);
        return calendar;
    }

    private OrgEventResponse toResponse(Event event, EventDispatch dispatch, EventRecipient receipt) {
        return new OrgEventResponse(event.getId(), dispatch.getId(), event.getTitle(),
                event.getDescription(), event.getLocation(), event.getStartAt(), event.getEndAt(),
                event.getAllDay(), event.getTimezone(), event.getRrule(), dispatch.getRequireReceipt(),
                receipt == null ? null : receipt.getReceiptStatus(),
                receipt == null ? null : receipt.getReceiptAt(),
                receipt == null ? null : receipt.getRemark(),
                receipt != null && receipt.getReadAt() != null);
    }
}
