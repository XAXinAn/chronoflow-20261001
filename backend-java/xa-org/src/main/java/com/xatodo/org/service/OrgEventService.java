package com.xatodo.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.dto.OrgDtos.OrgEventDispatchRequest;
import com.xatodo.org.dto.OrgDtos.OrgEventManageItem;
import com.xatodo.org.dto.OrgDtos.OrgEventResponse;
import com.xatodo.org.dto.OrgDtos.OrgEventUpdateRequest;
import com.xatodo.org.entity.Department;
import com.xatodo.org.entity.EventDispatch;
import com.xatodo.org.entity.EventRecipient;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.entity.Organization;
import com.xatodo.org.mapper.EventDispatchMapper;
import com.xatodo.org.mapper.EventRecipientMapper;
import com.xatodo.org.mapper.DepartmentMapper;
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

    private final OrgPermissionService permission;
    private final DepartmentService departmentService;
    private final OrgMemberMapper orgMemberMapper;
    private final OrganizationMapper organizationMapper;
    private final DepartmentMapper departmentMapper;
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
                           DepartmentMapper departmentMapper,
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
        this.departmentMapper = departmentMapper;
        this.eventDispatchMapper = eventDispatchMapper;
        this.eventRecipientMapper = eventRecipientMapper;
        this.eventMapper = eventMapper;
        this.eventExceptionMapper = eventExceptionMapper;
        this.calendarMapper = calendarMapper;
        this.expander = expander;
    }

    // ------------------------------------------------------------------ 下发

    @Transactional
    public OrgEventResponse dispatch(OrgActor actor, OrgEventDispatchRequest request) {
        if (!request.endAt().isAfter(request.startAt())) {
            throw BizException.of(ErrorCode.EVENT_TIME_INVALID);
        }
        expander.validate(request.rrule());
        if (StringUtils.hasText(request.rrule())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "首版组织日程暂不支持重复规则");
        }

        List<OrgMember> recipients = withInitiator(resolveRecipients(actor, request), actor);
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
        // 组织日程目前只用「地点名称」这一个字段（V9 起该列叫 location_name）；
        // 结构化的地址与坐标留给后续的组织日程编辑器，见 spec §5.9
        event.setLocationName(request.location());
        event.setLocationDetail(StringUtils.hasText(request.locationDetail())
                ? request.locationDetail().trim() : null);
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
        // 发起方二选一：成员（App）记成员 id，后台组织管理员（Web）记 admin_user id（spec §5.6）
        dispatch.setCreatedByMemberId(actor.getId());
        dispatch.setCreatedByAdminId(actor.getAdminId());
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
            eventRecipientMapper.insert(row);
        }

        return toResponse(event, dispatch);
    }

    /**
     * 撤回下发：撤回后成员端不再展示（spec §4.2.2）。首版不收集回执，因此没有「已回执不可撤回」这回事。
     */
    @Transactional
    public void revoke(OrgActor actor, Long eventId) {
        EventDispatch dispatch = requireActiveDispatch(actor.getOrgId(), eventId);
        requireIsInitiator(actor, dispatch);

        dispatch.setStatus(EventDispatch.STATUS_REVOKED);
        eventDispatchMapper.updateById(dispatch);
    }

    /**
     * 修改组织日程。改动后标记「已更新」；{@code redispatch=true} 时按原范围补投新增成员，
     * 已有成员的回执记录保持不变（spec §4.2.2）。
     */
    @Transactional
    public OrgEventResponse update(OrgActor actor, Long eventId, OrgEventUpdateRequest request) {
        EventDispatch dispatch = requireActiveDispatch(actor.getOrgId(), eventId);
        requireIsInitiator(actor, dispatch);

        Event event = eventMapper.selectById(eventId);
        if (event == null || event.getDeletedAt() != null) {
            throw BizException.of(ErrorCode.FORBIDDEN, "日程不存在");
        }

        OffsetDateTime start = request.startAt() != null ? request.startAt() : event.getStartAt();
        OffsetDateTime end = request.endAt() != null ? request.endAt() : event.getEndAt();
        if (!end.isAfter(start)) {
            throw BizException.of(ErrorCode.EVENT_TIME_INVALID);
        }
        if (StringUtils.hasText(request.title())) {
            event.setTitle(request.title());
        }
        if (request.description() != null) {
            event.setDescription(request.description());
        }
        if (request.location() != null) {
            event.setLocationName(request.location());
        }
        if (request.locationDetail() != null) {
            event.setLocationDetail(StringUtils.hasText(request.locationDetail())
                    ? request.locationDetail().trim() : null);
        }
        event.setStartAt(start);
        event.setEndAt(end);
        if (request.allDay() != null) {
            event.setAllDay(request.allDay());
        }
        if (StringUtils.hasText(request.timezone())) {
            event.setTimezone(request.timezone());
        }
        event.setUpdatedAfterDispatch(true);
        eventMapper.updateById(event);

        if (Boolean.TRUE.equals(request.redispatch())) {
            redispatch(actor, dispatch);
        }
        return toResponse(event, dispatch);
    }

    /**
     * 删除组织日程：软删日程并将下发记录置为 REVOKED，成员端随即不再展示。
     */
    @Transactional
    public void delete(OrgActor actor, Long eventId) {
        EventDispatch dispatch = requireActiveDispatch(actor.getOrgId(), eventId);
        requireIsInitiator(actor, dispatch);

        Event event = eventMapper.selectById(eventId);
        if (event != null) {
            event.setDeletedAt(OffsetDateTime.now(ZoneOffset.UTC));
            event.setStatus(Event.STATUS_CANCELLED);
            eventMapper.updateById(event);
        }
        dispatch.setStatus(EventDispatch.STATUS_REVOKED);
        eventDispatchMapper.updateById(dispatch);
    }

    /**
     * 重新下发：按原范围补齐新增成员，已存在的收件记录（含回执）原样保留。
     */
    private void redispatch(OrgActor actor, EventDispatch dispatch) {
        if (EventDispatch.SCOPE_MEMBER.equals(dispatch.getScopeType())) {
            return;   // 指定成员下发不自动扩充目标
        }
        List<OrgMember> targets;
        if (EventDispatch.SCOPE_ALL.equals(dispatch.getScopeType())) {
            targets = activeMembers(dispatch.getOrgId(), null);
        } else {
            Department department = departmentMapper.selectById(dispatch.getDepartmentId());
            if (department == null) {
                return;
            }
            Set<Long> scope = permission.resolveDepartmentScope(
                    department, Boolean.TRUE.equals(dispatch.getIncludeSubDepartments()));
            targets = activeMembers(dispatch.getOrgId(), scope);
        }

        Set<Long> existing = eventRecipientMapper.selectList(
                        new LambdaQueryWrapper<EventRecipient>()
                                .eq(EventRecipient::getDispatchId, dispatch.getId()))
                .stream().map(EventRecipient::getOrgMemberId).collect(Collectors.toSet());

        int added = 0;
        for (OrgMember target : targets) {
            if (existing.contains(target.getId())) {
                continue;
            }
            EventRecipient row = new EventRecipient();
            row.setDispatchId(dispatch.getId());
            row.setEventId(dispatch.getEventId());
            row.setOrgMemberId(target.getId());
            row.setDepartmentId(target.getDepartmentId());
            eventRecipientMapper.insert(row);
            added++;
        }
        if (added > 0) {
            dispatch.setRecipientCount(dispatch.getRecipientCount() + added);
            eventDispatchMapper.updateById(dispatch);
        }
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
        if (activeDispatchIds.isEmpty()) {
            // 下发都被撤回了：成员端不该再看到任何东西。
            // 这里必须提前返回——空集合进 `IN ()` 会拼出非法 SQL 直接 500（实测踩过）。
            return List.of();
        }
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
                        occurrence.locationName(), occurrence.locationDetail(),
                        OffsetDateTime.ofInstant(occurrence.startAt(), ZoneOffset.UTC),
                        OffsetDateTime.ofInstant(occurrence.endAt(), ZoneOffset.UTC),
                        occurrence.allDay(), occurrence.timezone(), event.getRrule(),
                        receipt.getReadAt() != null,
                        isInitiator(permission.memberActor(member), dispatch)));
            }
        }
        result.sort(Comparator.comparing(OrgEventResponse::startAt)
                .thenComparing(OrgEventResponse::eventId));
        return result;
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

    /**
     * 组织管理端（Web）的组织日程列表（spec §6.3 `GET /org-admin/events`）。
     *
     * <p>这里是本组织的**全部活跃下发**，并附回执分布，管理端一眼看到「谁还没回执」。
     * 已撤回的下发不再出现在列表里——和成员端展示口径一致。
     */
    public List<OrgEventManageItem> listForAdmin(OrgActor actor, Instant start, Instant end) {
        permission.requireOrgAdmin(actor);
        OffsetDateTime from = OffsetDateTime.ofInstant(start, ZoneOffset.UTC);
        OffsetDateTime to = OffsetDateTime.ofInstant(end, ZoneOffset.UTC);

        List<Event> events = eventMapper.selectList(new LambdaQueryWrapper<Event>()
                .eq(Event::getOrgId, actor.getOrgId())
                .isNull(Event::getDeletedAt)
                .lt(Event::getStartAt, to)
                .gt(Event::getEndAt, from)
                .orderByAsc(Event::getStartAt));
        if (events.isEmpty()) {
            return List.of();
        }

        Map<Long, EventDispatch> dispatches = eventDispatchMapper.selectList(
                        new LambdaQueryWrapper<EventDispatch>()
                                .in(EventDispatch::getEventId, events.stream().map(Event::getId).toList())
                                .eq(EventDispatch::getStatus, EventDispatch.STATUS_ACTIVE))
                .stream().collect(Collectors.toMap(EventDispatch::getEventId, dispatch -> dispatch,
                        (existing, replacement) -> existing));
        List<OrgEventManageItem> result = new ArrayList<>();
        for (Event event : events) {
            EventDispatch dispatch = dispatches.get(event.getId());
            if (dispatch == null) {
                continue;   // 没有活跃下发记录的日程不属于管理端列表
            }
            result.add(new OrgEventManageItem(event.getId(), dispatch.getId(), event.getTitle(),
                    event.getDescription(), event.getLocationName(), event.getLocationDetail(),
                    event.getStartAt(), event.getEndAt(),
                    event.getAllDay(), event.getTimezone(), dispatch.getScopeType(),
                    dispatch.getDepartmentId(), dispatch.getRecipientCount()));
        }
        return result;
    }

    // ------------------------------------------------------------- 内部实现

    private List<OrgMember> resolveRecipients(OrgActor actor, OrgEventDispatchRequest request) {
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

    /**
     * 下发对象里永远包含**发起人自己**（spec §4.2.2）。
     *
     * <p>组织 tab 的列表口径是「发给我 / 我参与的」：发起人如果不在收件名单里，
     * 自己刚下发的东西下一秒在自己日历里就看不见了——自己的日程自己看不到，说不过去。
     * 后台管理员没有 {@code org_member} 记录，自然不参与。
     */
    private List<OrgMember> withInitiator(List<OrgMember> recipients, OrgActor actor) {
        if (actor.getId() == null) {
            return recipients;
        }
        if (recipients.stream().anyMatch(member -> actor.getId().equals(member.getId()))) {
            return recipients;
        }
        OrgMember self = orgMemberMapper.selectById(actor.getId());
        if (self == null || !OrgMember.STATUS_ACTIVE.equals(self.getStatus())) {
            return recipients;
        }
        List<OrgMember> merged = new ArrayList<>(recipients);
        merged.add(self);
        return merged;
    }

    /**
     * 我是不是这条下发的**发起人**（spec §4.2.2）。
     *
     * <p>发起人由谁下发决定：App 里是组织身份（可能是部门管理员），Web 组织管理端是后台管理员。
     */
    private boolean isInitiator(OrgActor actor, EventDispatch dispatch) {
        if (actor.isAdminActor()) {
            return actor.getAdminId().equals(dispatch.getCreatedByAdminId());
        }
        return actor.getId() != null && actor.getId().equals(dispatch.getCreatedByMemberId());
    }

    /**
     * 修改类操作（改 / 撤 / 删）**只有发起人本人**能做，组织管理员也不行：
     * 已经发给别人的通知，内容该由发的人负责；管理员要改就自己另发一条。
     */
    private void requireIsInitiator(OrgActor actor, EventDispatch dispatch) {
        if (!isInitiator(actor, dispatch)) {
            throw BizException.of(ErrorCode.FORBIDDEN, "只有下发者本人可以修改这条组织日程");
        }
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

    private OrgEventResponse toResponse(Event event, EventDispatch dispatch) {
        return new OrgEventResponse(event.getId(), dispatch.getId(), event.getTitle(),
                event.getDescription(), event.getLocationName(), event.getLocationDetail(),
                event.getStartAt(), event.getEndAt(),
                event.getAllDay(), event.getTimezone(), event.getRrule(), false,
                // 能走到这里的调用者已经过了权限校验（下发/修改的返回体）：对自己刚动过的东西当然可编辑
                true);
    }
}
