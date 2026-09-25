package com.xatodo.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.entity.Department;
import com.xatodo.org.entity.DepartmentManager;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.mapper.DepartmentManagerMapper;
import com.xatodo.org.mapper.DepartmentMapper;
import com.xatodo.org.mapper.OrgMemberMapper;
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

    public OrgPermissionService(OrgMemberMapper orgMemberMapper,
                                DepartmentMapper departmentMapper,
                                DepartmentManagerMapper departmentManagerMapper) {
        this.orgMemberMapper = orgMemberMapper;
        this.departmentMapper = departmentMapper;
        this.departmentManagerMapper = departmentManagerMapper;
    }

    /**
     * 由当前身份解析出组织成员关系；没有组织身份或成员关系不可用时一律拒绝。
     */
    public OrgMember requireMembership(IdentityPrincipal principal) {
        if (principal.orgId() == null) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该接口需要组织身份");
        }
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
