package com.xatodo.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.auth.entity.Identity;
import com.xatodo.auth.mapper.IdentityMapper;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.auth.service.TokenService;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.dto.OrgDtos.OrgCurrentResponse;
import com.xatodo.org.dto.OrgDtos.OrgMemberCreateRequest;
import com.xatodo.org.dto.OrgDtos.OrgMemberResponse;
import com.xatodo.org.dto.OrgDtos.OrgMemberUpdateRequest;
import com.xatodo.org.entity.Department;
import com.xatodo.org.entity.DepartmentManager;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.entity.Organization;
import com.xatodo.org.mapper.DepartmentManagerMapper;
import com.xatodo.org.mapper.OrgMemberMapper;
import com.xatodo.org.mapper.OrganizationMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 组织成员管理。成员账号由管理员创建（不可自助注册，spec §3.1）。
 */
@Service
public class OrgMemberService {

    private static final Set<String> ROLES =
            Set.of(OrgMember.ROLE_OWNER, OrgMember.ROLE_ADMIN, OrgMember.ROLE_MEMBER);
    private static final Set<String> STATUSES =
            Set.of(OrgMember.STATUS_ACTIVE, OrgMember.STATUS_DISABLED, OrgMember.STATUS_LEFT);

    private final OrgMemberMapper orgMemberMapper;
    private final OrganizationMapper organizationMapper;
    private final IdentityMapper identityMapper;
    private final TokenService tokenService;
    private final DepartmentManagerMapper departmentManagerMapper;
    private final DepartmentService departmentService;
    private final OrgPermissionService permission;

    public OrgMemberService(OrgMemberMapper orgMemberMapper,
                            OrganizationMapper organizationMapper,
                            IdentityMapper identityMapper,
                            TokenService tokenService,
                            DepartmentManagerMapper departmentManagerMapper,
                            DepartmentService departmentService,
                            OrgPermissionService permission) {
        this.orgMemberMapper = orgMemberMapper;
        this.organizationMapper = organizationMapper;
        this.identityMapper = identityMapper;
        this.tokenService = tokenService;
        this.departmentManagerMapper = departmentManagerMapper;
        this.departmentService = departmentService;
        this.permission = permission;
    }

    public OrgCurrentResponse current(IdentityPrincipal principal) {
        OrgMember member = permission.requireMembership(principal);
        Organization org = organizationMapper.selectById(member.getOrgId());
        if (org == null) {
            throw BizException.of(ErrorCode.IDENTITY_UNAVAILABLE, "组织不存在");
        }
        Department department = departmentService.requireInOrg(org.getId(), member.getDepartmentId());

        return new OrgCurrentResponse(
                org.getId(), org.getName(), org.getCode(), org.getLogoUrl(), org.getTimezone(),
                member.getId(), member.getRealName(), member.getMemberKey(), member.getJobTitle(),
                member.getOrgRole(), department.getId(), department.getName(),
                departmentPathNames(department),
                permission.isOrgAdmin(member),
                permission.manageableDepartmentIds(member));
    }

    /**
     * 成员列表。组织管理员看全组织；部门管理员看被授权部门及下级；普通成员只能看到自己。
     *
     * <p>后台管理员（Web 组织管理端）没有成员记录，但同样是「组织管理员」，看到全组织。
     */
    public List<OrgMemberResponse> list(OrgActor actor, Long departmentId) {
        LambdaQueryWrapper<OrgMember> query = new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, actor.getOrgId());

        Set<Long> scope = permission.manageableDepartmentIds(actor);
        if (!actor.isAdminActor() && scope.isEmpty()) {
            // 普通成员：只看得到自己
            query.eq(OrgMember::getId, actor.getId());
        } else {
            if (departmentId != null) {
                permission.requireCanManageDepartment(actor, departmentId);
                query.eq(OrgMember::getDepartmentId, departmentId);
            } else if (!actor.isAdminActor()) {
                query.in(OrgMember::getDepartmentId, scope);
            }
            query.ne(OrgMember::getStatus, OrgMember.STATUS_LEFT);
        }

        List<OrgMember> members = orgMemberMapper.selectList(query);
        if (members.isEmpty()) {
            return List.of();
        }

        Map<Long, Department> departments = new HashMap<>();
        permission.allDepartments(actor.getOrgId())
                .forEach(department -> departments.put(department.getId(), department));
        Set<Long> managerMemberIds = new LinkedHashSet<>();
        departmentManagerMapper.selectList(new LambdaQueryWrapper<DepartmentManager>()
                        .in(DepartmentManager::getOrgMemberId,
                                members.stream().map(OrgMember::getId).toList()))
                .forEach(grant -> managerMemberIds.add(grant.getOrgMemberId()));

        List<OrgMemberResponse> result = new ArrayList<>();
        for (OrgMember member : members) {
            Department department = departments.get(member.getDepartmentId());
            result.add(toResponse(member, department, managerMemberIds.contains(member.getId())));
        }
        return result;
    }

    /** 成员 → 响应。`bound` 让管理端一眼看出哪些成员还没认领组织账号。 */
    private OrgMemberResponse toResponse(OrgMember member, Department department, boolean departmentManager) {
        return new OrgMemberResponse(
                member.getId(), member.getIdentityId(), member.getIdentityId() != null,
                member.getDepartmentId(), department == null ? null : department.getName(),
                member.getRealName(), member.getMemberKey(), member.getJobTitle(),
                member.getOrgRole(), member.getStatus(), departmentManager);
    }

    /**
     * 新增成员：只写成员唯一识别 ID（spec §3.1）。
     *
     * <p>不创建账号、不创建身份——身份等成员自己用「组织唯一 ID + 唯一识别 ID」认领组织账号时产生。
     */
    @Transactional
    public OrgMemberResponse create(OrgActor actor, OrgMemberCreateRequest request) {
        Department department = departmentService.requireInOrg(actor.getOrgId(), request.departmentId());
        permission.requireCanManageDepartment(actor, department.getId());

        String role = StringUtils.hasText(request.orgRole()) ? request.orgRole() : OrgMember.ROLE_MEMBER;
        if (!ROLES.contains(role)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "组织角色取值非法: " + role);
        }
        if (!OrgMember.ROLE_MEMBER.equals(role)) {
            permission.requireOrgAdmin(actor);
        }

        OrgMember member = createMemberInternal(actor.getOrgId(), department.getId(),
                request.memberKey(), request.realName(), request.jobTitle(), role);
        return toResponse(member, department, false);
    }

    /**
     * 创建成员的内部实现：不做权限校验（由调用方保证），供单条新增与批量导入共用。
     */
    @Transactional
    public OrgMember createMemberInternal(Long orgId, Long departmentId, String memberKey, String realName,
                                          String jobTitle, String role) {
        String key = memberKey == null ? "" : memberKey.trim();
        if (key.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "成员唯一识别 ID 不能为空");
        }
        Long duplicated = orgMemberMapper.selectCount(new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, orgId)
                .eq(OrgMember::getMemberKey, key));
        if (duplicated != null && duplicated > 0) {
            throw BizException.of(ErrorCode.MEMBER_ALREADY_EXISTS,
                    "该唯一识别 ID 已经是本组织成员：" + key);
        }

        OrgMember member = new OrgMember();
        member.setOrgId(orgId);
        member.setDepartmentId(departmentId);
        member.setRealName(realName);
        member.setMemberKey(key);
        member.setJobTitle(jobTitle);
        member.setOrgRole(role);
        member.setStatus(OrgMember.STATUS_ACTIVE);
        orgMemberMapper.insert(member);
        return member;
    }

    /**
     * 解绑成员的组织账号（spec §3.2）：清掉认领关系、停用其组织身份并吊销令牌。
     *
     * <p>成员被冒领、或换了个人账号时靠它恢复；组织侧的成员记录保留。
     */
    @Transactional
    public OrgMemberResponse unbind(OrgActor actor, Long memberId) {
        OrgMember target = requireMemberInOrg(actor.getOrgId(), memberId);
        permission.requireCanManageDepartment(actor, target.getDepartmentId());
        unbindInternal(target);
        Department department = departmentService.requireInOrg(actor.getOrgId(), target.getDepartmentId());
        return toResponse(target, department, false);
    }

    /** 解绑的内部实现（不做权限校验），供组织账号解绑与管理员解绑共用。 */
    @Transactional
    public void unbindInternal(OrgMember member) {
        Long identityId = member.getIdentityId();
        if (identityId != null) {
            Identity identity = identityMapper.selectById(identityId);
            if (identity != null) {
                identity.setStatus("DISABLED");
                identityMapper.updateById(identity);
            }
            // 会话必须一起吊销：否则「删掉登录记录」只删了 App 那一份，服务端令牌还能用
            tokenService.revokeAllForIdentity(identityId);
        }
        member.setIdentityId(null);
        orgMemberMapper.updateById(member);
    }

    /**
     * 编辑成员：调岗、改角色、停用。拥有者不可被降级，避免组织失去唯一拥有者。
     */
    @Transactional
    public OrgMemberResponse update(OrgActor actor, Long memberId, OrgMemberUpdateRequest request) {
        OrgMember target = requireMemberInOrg(actor.getOrgId(), memberId);

        boolean selfEdit = target.getId().equals(actor.getId());
        if (!selfEdit) {
            permission.requireCanManageDepartment(actor, target.getDepartmentId());
        } else if (!permission.isOrgAdmin(actor)) {
            throw BizException.of(ErrorCode.FORBIDDEN, "普通成员不能修改成员信息");
        }

        if (request.departmentId() != null && !request.departmentId().equals(target.getDepartmentId())) {
            Department department = departmentService.requireInOrg(actor.getOrgId(), request.departmentId());
            permission.requireCanManageDepartment(actor, department.getId());
            target.setDepartmentId(department.getId());
        }
        if (StringUtils.hasText(request.realName())) {
            target.setRealName(request.realName());
        }
        if (request.memberKey() != null) {
            String key = request.memberKey().trim();
            if (!key.isEmpty() && !key.equals(target.getMemberKey())) {
                Long duplicated = orgMemberMapper.selectCount(new LambdaQueryWrapper<OrgMember>()
                        .eq(OrgMember::getOrgId, actor.getOrgId())
                        .eq(OrgMember::getMemberKey, key));
                if (duplicated != null && duplicated > 0) {
                    throw BizException.of(ErrorCode.MEMBER_ALREADY_EXISTS,
                            "该唯一识别 ID 已经是本组织成员：" + key);
                }
                target.setMemberKey(key);
            }
        }
        if (request.jobTitle() != null) {
            target.setJobTitle(request.jobTitle());
        }
        if (StringUtils.hasText(request.orgRole())) {
            if (!ROLES.contains(request.orgRole())) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "组织角色取值非法: " + request.orgRole());
            }
            permission.requireOrgAdmin(actor);
            if (OrgMember.ROLE_OWNER.equals(target.getOrgRole())
                    && !OrgMember.ROLE_OWNER.equals(request.orgRole())) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "拥有者不可被降级，请先转让拥有者");
            }
            target.setOrgRole(request.orgRole());
        }
        if (StringUtils.hasText(request.status())) {
            if (!STATUSES.contains(request.status())) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "成员状态取值非法: " + request.status());
            }
            permission.requireOrgAdmin(actor);
            if (OrgMember.ROLE_OWNER.equals(target.getOrgRole())
                    && !OrgMember.STATUS_ACTIVE.equals(request.status())) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "拥有者不可被停用");
            }
            target.setStatus(request.status());
            syncIdentityStatus(target);
        }
        orgMemberMapper.updateById(target);

        Department department = departmentService.requireInOrg(actor.getOrgId(), target.getDepartmentId());
        return toResponse(target, department, false);
    }

    public OrgMember requireMemberInOrg(Long orgId, Long memberId) {
        OrgMember member = orgMemberMapper.selectById(memberId);
        if (member == null || !orgId.equals(member.getOrgId())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "成员不存在或不属于当前组织");
        }
        return member;
    }

    /**
     * 成员停用时同步停用其组织身份，刷新令牌随即失效（spec §10.1 必测场景 9）。
     */
    private void syncIdentityStatus(OrgMember member) {
        // 未认领的成员没有组织身份，没什么可同步的
        if (member.getIdentityId() == null) {
            return;
        }
        Identity identity = identityMapper.selectById(member.getIdentityId());
        if (identity == null) {
            return;
        }
        identity.setStatus(OrgMember.STATUS_ACTIVE.equals(member.getStatus()) ? "ACTIVE" : "DISABLED");
        identityMapper.updateById(identity);
    }

    private List<String> departmentPathNames(Department department) {
        if (!StringUtils.hasText(department.getPath())) {
            return List.of(department.getName());
        }
        String[] segments = department.getPath().split("/");
        List<Long> ids = new ArrayList<>();
        for (String segment : segments) {
            if (!segment.isBlank()) {
                ids.add(Long.valueOf(segment));
            }
        }
        if (ids.isEmpty()) {
            return List.of(department.getName());
        }
        Map<Long, String> names = new HashMap<>();
        for (Long id : ids) {
            Department node = departmentService.requireInOrg(department.getOrgId(), id);
            names.put(id, node.getName());
        }
        List<String> result = new ArrayList<>();
        for (Long id : ids) {
            result.add(names.getOrDefault(id, String.valueOf(id)));
        }
        return Collections.unmodifiableList(result);
    }

    @SuppressWarnings("unused")
    private OffsetDateTime now() {
        return OffsetDateTime.now(ZoneOffset.UTC);
    }
}
