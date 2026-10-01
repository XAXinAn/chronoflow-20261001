package com.chronoflow.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.chronoflow.auth.security.AdminActor;
import com.chronoflow.auth.security.IdentityPrincipal;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.org.entity.Department;
import com.chronoflow.org.entity.DepartmentManager;
import com.chronoflow.org.entity.OrgMember;
import com.chronoflow.org.entity.Organization;
import com.chronoflow.org.mapper.DepartmentManagerMapper;
import com.chronoflow.org.mapper.DepartmentMapper;
import com.chronoflow.org.mapper.OrgMemberMapper;
import com.chronoflow.org.mapper.OrganizationMapper;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 组织权限判定。所有组织内的写操作都必须经过这里，不允许只靠前端隐藏入口（spec §7.1）。
 *
 * <p>部门树使用物化路径（形如 {@code /5/12/}），因此「本部门及所有下级」可用一次
 * {@code path LIKE '/5/%'} 完成；路径结尾的斜杠避免了 {@code /5} 误匹配 {@code /51} 的经典前缀问题。
 */
@Service
public class OrgPermissionService {

    private final OrgMemberMapper orgMemberMapper;
    private final DepartmentMapper departmentMapper;
    private final DepartmentManagerMapper departmentManagerMapper;
    private final OrganizationMapper organizationMapper;

    public OrgPermissionService(OrgMemberMapper orgMemberMapper,
                                DepartmentMapper departmentMapper,
                                DepartmentManagerMapper departmentManagerMapper,
                                OrganizationMapper organizationMapper) {
        this.orgMemberMapper = orgMemberMapper;
        this.departmentMapper = departmentMapper;
        this.departmentManagerMapper = departmentManagerMapper;
        this.organizationMapper = organizationMapper;
    }

    /**
     * 由当前身份解析出组织成员关系；没有组织身份或成员关系不可用时一律拒绝。
     */
    public OrgMember requireMembership(IdentityPrincipal principal) {
        if (principal.orgId() == null) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该接口需要组织身份");
        }
        // 组织被平台停用 / 禁用后，成员不得再访问组织接口（spec §10.1 必测场景 10）
        requireActiveOrganization(principal.orgId());
        OrgMember member = orgMemberMapper.selectOne(new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, principal.orgId())
                .eq(OrgMember::getIdentityId, principal.identityId()));
        if (member == null) {
            throw BizException.of(ErrorCode.IDENTITY_UNAVAILABLE, "组织成员关系不存在");
        }
        if (!OrgMember.STATUS_ACTIVE.equals(member.getStatus())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "组织成员身份已停用");
        }
        return member;
    }

    public boolean isOrgAdmin(OrgMember member) {
        return OrgMember.ROLE_OWNER.equals(member.getOrgRole())
                || OrgMember.ROLE_ADMIN.equals(member.getOrgRole());
    }

    public void requireOrgAdmin(OrgMember member) {
        if (!isOrgAdmin(member)) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该操作需要组织管理员权限");
        }
    }

    /**
     * 把当前安全上下文解析成组织执行者（spec §3.2 / §4.3）。
     *
     * <p>两条入口都通向「组织管理员」这个角色：App 的组织身份令牌，或 Web 组织管理端的后台管理员令牌。
     */
    public OrgActor resolveActor() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        Object principal = authentication == null ? null : authentication.getPrincipal();
        if (principal instanceof AdminActor admin) {
            return adminActor(admin);
        }
        if (principal instanceof IdentityPrincipal identity) {
            return memberActor(requireMembership(identity));
        }
        throw BizException.of(ErrorCode.UNAUTHENTICATED);
    }

    public OrgActor memberActor(OrgMember member) {
        return OrgActor.ofMember(member, manageableDepartmentIds(member));
    }

    /**
     * 后台组织管理员 → 组织执行者。平台超管没有组织归属，组织管理端不归它用（spec §4.3）。
     */
    public OrgActor adminActor(AdminActor admin) {
        if (admin.orgId() == null || !AdminActor.ROLE_ORG_ADMIN.equals(admin.role())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该接口需要组织管理员身份");
        }
        requireActiveOrganization(admin.orgId());
        // 后台管理员不受部门限制（spec §2.2：组织管理员管理全组织）
        return OrgActor.ofAdmin(admin.adminId(), admin.username(), admin.orgId(),
                allDepartmentIds(admin.orgId()));
    }

    public boolean isOrgAdmin(OrgActor actor) {
        return actor.isOrgAdmin();
    }

    public void requireOrgAdmin(OrgActor actor) {
        if (!actor.isOrgAdmin()) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该操作需要组织管理员权限");
        }
    }

    public Set<Long> manageableDepartmentIds(OrgActor actor) {
        return actor.manageableDepartmentIds();
    }

    /**
     * 重新计算可管理部门集合。批量导入会在过程中自动补建部门，
     * 快照会过期，因此需要按当前库里的结构重算（spec §4.3 的「自动创建部门」开关）。
     */
    public Set<Long> refreshManageableDepartmentIds(OrgActor actor) {
        if (actor.isAdminActor()) {
            return allDepartmentIds(actor.getOrgId());
        }
        OrgMember member = orgMemberMapper.selectById(actor.getId());
        if (member == null) {
            return Set.of();
        }
        return manageableDepartmentIds(member);
    }

    /**
     * 要求当前执行者对目标部门具备管理权，否则拒绝。
     */
    public void requireCanManageDepartment(OrgActor actor, Long departmentId) {
        if (departmentId == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "departmentId 不能为空");
        }
        Department department = departmentMapper.selectById(departmentId);
        if (department == null || !actor.getOrgId().equals(department.getOrgId())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "部门不存在或不属于当前组织");
        }
        // 按当前库里的部门结构判断，而不是执行者对象里的快照：批量导入会在过程中自动补建部门，
        // 快照一过期，刚建出来的那一层就会把自己挡住。
        if (!refreshManageableDepartmentIds(actor).contains(departmentId)) {
            throw BizException.of(ErrorCode.FORBIDDEN, "无权管理该部门");
        }
    }

    /**
     * 当前成员可管理的部门集合：组织管理员为全组织；部门管理员为其被授权部门及所有下级；否则为空。
     */
    public Set<Long> manageableDepartmentIds(OrgMember member) {
        if (isOrgAdmin(member)) {
            return allDepartmentIds(member.getOrgId());
        }
        Set<Long> result = new LinkedHashSet<>();
        List<DepartmentManager> grants = departmentManagerMapper.selectList(
                new LambdaQueryWrapper<DepartmentManager>()
                        .eq(DepartmentManager::getOrgMemberId, member.getId()));
        for (DepartmentManager grant : grants) {
            Department department = departmentMapper.selectById(grant.getDepartmentId());
            if (department == null || !member.getOrgId().equals(department.getOrgId())) {
                continue;
            }
            selfAndDescendants(department).forEach(node -> result.add(node.getId()));
        }
        return result;
    }

    /**
     * 要求当前成员对目标部门具备管理权，否则拒绝。
     */
    public void requireCanManageDepartment(OrgMember member, Long departmentId) {
        if (departmentId == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "departmentId 不能为空");
        }
        Department department = departmentMapper.selectById(departmentId);
        if (department == null || !member.getOrgId().equals(department.getOrgId())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "部门不存在或不属于当前组织");
        }
        if (!manageableDepartmentIds(member).contains(departmentId)) {
            throw BizException.of(ErrorCode.FORBIDDEN, "无权管理该部门");
        }
    }

    /**
     * 组织本身必须是有效租户：不存在、已软删、已停用都直接拒绝（spec §10.1 必测场景 10）。
     */
    public Organization requireActiveOrganization(Long orgId) {
        Organization organization = organizationMapper.selectById(orgId);
        if (organization == null || organization.getDeletedAt() != null
                || !Organization.STATUS_ACTIVE.equals(organization.getStatus())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "组织已停用");
        }
        return organization;
    }

    public List<Department> allDepartments(Long orgId) {
        return departmentMapper.selectList(new LambdaQueryWrapper<Department>()
                .eq(Department::getOrgId, orgId)
                .eq(Department::getStatus, Department.STATUS_ACTIVE)
                .orderByAsc(Department::getLevel)
                .orderByAsc(Department::getSortOrder)
                .orderByAsc(Department::getId));
    }

    public Set<Long> allDepartmentIds(Long orgId) {
        Set<Long> ids = new LinkedHashSet<>();
        allDepartments(orgId).forEach(department -> ids.add(department.getId()));
        return ids;
    }

    /**
     * 部门自身 + 所有下级部门。
     */
    public List<Department> selfAndDescendants(Department department) {
        return departmentMapper.selectList(new LambdaQueryWrapper<Department>()
                .eq(Department::getOrgId, department.getOrgId())
                .eq(Department::getStatus, Department.STATUS_ACTIVE)
                .likeRight(Department::getPath, department.getPath()));
    }

    public Set<Long> resolveDepartmentScope(Department department, boolean includeSubDepartments) {
        Set<Long> ids = new HashSet<>();
        ids.add(department.getId());
        if (includeSubDepartments) {
            selfAndDescendants(department).forEach(node -> ids.add(node.getId()));
        }
        return ids;
    }
}
