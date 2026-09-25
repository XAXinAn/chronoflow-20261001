package com.xatodo.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.dto.OrgDtos.DepartmentCreateRequest;
import com.xatodo.org.dto.OrgDtos.DepartmentNode;
import com.xatodo.org.dto.OrgDtos.DepartmentUpdateRequest;
import com.xatodo.org.entity.Department;
import com.xatodo.org.entity.DepartmentManager;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.mapper.DepartmentManagerMapper;
import com.xatodo.org.mapper.DepartmentMapper;
import com.xatodo.org.mapper.OrgMemberMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 部门树维护。层级上限 5 层（spec §4.2.1），路径在插入后按自增 id 回填。
 */
@Service
public class DepartmentService {

    private final DepartmentMapper departmentMapper;
    private final DepartmentManagerMapper departmentManagerMapper;
    private final OrgMemberMapper orgMemberMapper;
    private final OrgPermissionService permission;

    public DepartmentService(DepartmentMapper departmentMapper,
                             DepartmentManagerMapper departmentManagerMapper,
                             OrgMemberMapper orgMemberMapper,
                             OrgPermissionService permission) {
        this.departmentMapper = departmentMapper;
        this.departmentManagerMapper = departmentManagerMapper;
        this.orgMemberMapper = orgMemberMapper;
        this.permission = permission;
    }

    /**
     * 组织部门树。树形结构在应用层按 {@code parentId} 组装，一次查询取全量部门。
     */
    public List<DepartmentNode> tree(Long orgId) {
        List<Department> all = permission.allDepartments(orgId);
        Map<Long, List<Department>> childrenByParent = new LinkedHashMap<>();
        for (Department department : all) {
            childrenByParent.computeIfAbsent(department.getParentId(), key -> new ArrayList<>())
                    .add(department);
        }
        return buildNodes(null, childrenByParent);
    }

    @Transactional
    public Department create(OrgMember actor, DepartmentCreateRequest request) {
        Department parent = null;
        if (request.parentId() != null) {
            parent = requireInOrg(actor.getOrgId(), request.parentId());
            permission.requireCanManageDepartment(actor, parent.getId());
            if (parent.getLevel() >= Department.MAX_LEVEL) {
                throw BizException.of(ErrorCode.DEPARTMENT_LEVEL_EXCEEDED,
                        "部门层级最多 " + Department.MAX_LEVEL + " 层");
            }
        } else {
            // 根部门仅组织管理员可创建
            permission.requireOrgAdmin(actor);
        }

        Department department = new Department();
        department.setOrgId(actor.getOrgId());
        department.setParentId(parent == null ? null : parent.getId());
        department.setName(request.name());
        department.setLevel((short) (parent == null ? 1 : parent.getLevel() + 1));
        department.setSortOrder(request.sortOrder() == null ? 0 : request.sortOrder());
        department.setStatus(Department.STATUS_ACTIVE);
        department.setPath("/");
        departmentMapper.insert(department);

        String parentPath = parent == null ? "/" : parent.getPath();
        department.setPath(parentPath + department.getId() + "/");
        departmentMapper.updateById(department);
        return department;
    }

    @Transactional
    public Department update(OrgMember actor, Long departmentId, DepartmentUpdateRequest request) {
        Department department = requireInOrg(actor.getOrgId(), departmentId);
        permission.requireCanManageDepartment(actor, departmentId);
        if (StringUtils.hasText(request.name())) {
            department.setName(request.name());
        }
        if (request.sortOrder() != null) {
            department.setSortOrder(request.sortOrder());
        }
        departmentMapper.updateById(department);
        return department;
    }

    @Transactional
    public void delete(OrgMember actor, Long departmentId) {
        Department department = requireInOrg(actor.getOrgId(), departmentId);
        permission.requireCanManageDepartment(actor, departmentId);

        List<Department> descendants = permission.selfAndDescendants(department).stream()
                .filter(node -> !node.getId().equals(departmentId))
                .toList();
        if (!descendants.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "请先删除下级部门");
        }
        Long members = orgMemberMapper.selectCount(new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getDepartmentId, departmentId));
        if (members != null && members > 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "部门下仍有成员，无法删除");
        }
        departmentManagerMapper.delete(new LambdaQueryWrapper<DepartmentManager>()
                .eq(DepartmentManager::getDepartmentId, departmentId));
        departmentMapper.deleteById(departmentId);
    }

    @Transactional
    public void grantManager(OrgMember actor, Long departmentId, Long orgMemberId) {
        permission.requireOrgAdmin(actor);
        Department department = requireInOrg(actor.getOrgId(), departmentId);
        OrgMember target = requireMemberInOrg(actor.getOrgId(), orgMemberId);

        Long existing = departmentManagerMapper.selectCount(new LambdaQueryWrapper<DepartmentManager>()
                .eq(DepartmentManager::getDepartmentId, department.getId())
                .eq(DepartmentManager::getOrgMemberId, target.getId()));
        if (existing != null && existing > 0) {
            return;
        }
        DepartmentManager grant = new DepartmentManager();
        grant.setDepartmentId(department.getId());
        grant.setOrgMemberId(target.getId());
        departmentManagerMapper.insert(grant);
    }

    @Transactional
    public void revokeManager(OrgMember actor, Long departmentId, Long orgMemberId) {
        permission.requireOrgAdmin(actor);
        departmentManagerMapper.delete(new LambdaQueryWrapper<DepartmentManager>()
                .eq(DepartmentManager::getDepartmentId, departmentId)
                .eq(DepartmentManager::getOrgMemberId, orgMemberId));
    }

    public Department requireInOrg(Long orgId, Long departmentId) {
        Department department = departmentMapper.selectById(departmentId);
        if (department == null || !orgId.equals(department.getOrgId())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "部门不存在或不属于当前组织");
        }
        return department;
    }

    private OrgMember requireMemberInOrg(Long orgId, Long orgMemberId) {
        OrgMember member = orgMemberMapper.selectById(orgMemberId);
        if (member == null || !orgId.equals(member.getOrgId())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "成员不存在或不属于当前组织");
        }
        return member;
    }

    private List<DepartmentNode> buildNodes(Long parentId, Map<Long, List<Department>> childrenByParent) {
        List<Department> children = childrenByParent.get(parentId);
        if (children == null || children.isEmpty()) {
            return List.of();
        }
        return children.stream()
                .sorted(Comparator.comparing(Department::getSortOrder, Comparator.nullsLast(Integer::compareTo))
                        .thenComparing(Department::getId))
                .map(department -> new DepartmentNode(
                        department.getId(),
                        department.getParentId(),
                        department.getName(),
                        department.getLevel(),
                        department.getPath(),
                        department.getSortOrder(),
                        buildNodes(department.getId(), childrenByParent)))
                .toList();
    }
}
