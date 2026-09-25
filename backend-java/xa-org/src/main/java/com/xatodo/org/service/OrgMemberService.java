package com.xatodo.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.auth.entity.Account;
import com.xatodo.auth.entity.Identity;
import com.xatodo.auth.mapper.AccountMapper;
import com.xatodo.auth.mapper.IdentityMapper;
import com.xatodo.auth.security.IdentityPrincipal;
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
    private final AccountMapper accountMapper;
    private final IdentityMapper identityMapper;
    private final DepartmentManagerMapper departmentManagerMapper;
    private final DepartmentService departmentService;
    private final OrgPermissionService permission;

    public OrgMemberService(OrgMemberMapper orgMemberMapper,
                            OrganizationMapper organizationMapper,
                            AccountMapper accountMapper,
                            IdentityMapper identityMapper,
                            DepartmentManagerMapper departmentManagerMapper,
                            DepartmentService departmentService,
                            OrgPermissionService permission) {
        this.orgMemberMapper = orgMemberMapper;
        this.organizationMapper = organizationMapper;
        this.accountMapper = accountMapper;
        this.identityMapper = identityMapper;
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
                member.getId(), member.getRealName(), member.getMemberNo(), member.getJobTitle(),
                member.getOrgRole(), department.getId(), department.getName(),
                departmentPathNames(department),
                permission.isOrgAdmin(member),
                permission.manageableDepartmentIds(member));
    }

    /**
     * 成员列表。组织管理员看全组织；部门管理员看被授权部门及下级；普通成员只能看到自己。
     */
    public List<OrgMemberResponse> list(OrgMember actor, Long departmentId) {
        LambdaQueryWrapper<OrgMember> query = new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, actor.getOrgId());

        Set<Long> scope = permission.manageableDepartmentIds(actor);
        if (scope.isEmpty()) {
            query.eq(OrgMember::getId, actor.getId());
        } else {
            if (departmentId != null) {
                permission.requireCanManageDepartment(actor, departmentId);
                query.eq(OrgMember::getDepartmentId, departmentId);
            } else {
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
            result.add(new OrgMemberResponse(
                    member.getId(), member.getIdentityId(), member.getDepartmentId(),
                    department == null ? null : department.getName(),
                    member.getRealName(), member.getMemberNo(), member.getJobTitle(),
                    member.getOrgRole(), member.getStatus(), managerMemberIds.contains(member.getId())));
        }
        return result;
    }

    /**
     * 新增成员：按手机号复用或创建账号，再建立组织身份与成员关系。
     */
    @Transactional
    public OrgMemberResponse create(OrgMember actor, OrgMemberCreateRequest request) {
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
                request.phone(), request.realName(), request.memberNo(), null, request.jobTitle(), role);
        return new OrgMemberResponse(member.getId(), member.getIdentityId(), department.getId(),
                department.getName(), member.getRealName(), member.getMemberNo(),
                member.getJobTitle(), member.getOrgRole(), member.getStatus(), false);
    }

    /**
     * 创建成员的内部实现：不做权限校验（由调用方保证），供单条新增与批量导入共用。
     *
     * <p>手机号对应账号不存在时自动创建，实现「管理员批量导入成员，创建账号」（spec §3.1）。
     */
    @Transactional
    public OrgMember createMemberInternal(Long orgId, Long departmentId, String phone, String realName,
                                          String memberNo, String email, String jobTitle, String role) {
        Account account = accountMapper.selectOne(new LambdaQueryWrapper<Account>()
                .eq(Account::getPhone, phone));
        if (account == null) {
            account = new Account();
            account.setPhone(phone);
            account.setEmail(email);
            account.setStatus("ACTIVE");
            accountMapper.insert(account);
        } else if (StringUtils.hasText(email) && !StringUtils.hasText(account.getEmail())) {
            account.setEmail(email);
            accountMapper.updateById(account);
        }

        Long existingIdentity = identityMapper.selectCount(new LambdaQueryWrapper<Identity>()
                .eq(Identity::getAccountId, account.getId())
                .eq(Identity::getOrgId, orgId));
        if (existingIdentity != null && existingIdentity > 0) {
            throw BizException.of(ErrorCode.MEMBER_ALREADY_EXISTS, "该手机号已是本组织成员");
        }

        Identity identity = new Identity();
        identity.setAccountId(account.getId());
        identity.setIdentityType(Identity.TYPE_ORG_MEMBER);
        identity.setOrgId(orgId);
        identity.setNickname(realName);
        identity.setStatus("ACTIVE");
        identityMapper.insert(identity);

        OrgMember member = new OrgMember();
        member.setOrgId(orgId);
        member.setIdentityId(identity.getId());
        member.setDepartmentId(departmentId);
        member.setRealName(realName);
        member.setMemberNo(StringUtils.hasText(memberNo) ? memberNo : null);
        member.setJobTitle(jobTitle);
        member.setOrgRole(role);
        member.setStatus(OrgMember.STATUS_ACTIVE);
        orgMemberMapper.insert(member);
        return member;
    }

    /**
     * 编辑成员：调岗、改角色、停用。拥有者不可被降级，避免组织失去唯一拥有者。
     */
    @Transactional
    public OrgMemberResponse update(OrgMember actor, Long memberId, OrgMemberUpdateRequest request) {
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
        if (request.memberNo() != null) {
            target.setMemberNo(request.memberNo());
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
        return new OrgMemberResponse(target.getId(), target.getIdentityId(), department.getId(),
                department.getName(), target.getRealName(), target.getMemberNo(),
                target.getJobTitle(), target.getOrgRole(), target.getStatus(), false);
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
