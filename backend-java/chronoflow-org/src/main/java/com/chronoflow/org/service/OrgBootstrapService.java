package com.chronoflow.org.service;

import com.chronoflow.org.entity.Department;
import com.chronoflow.org.entity.OrgMember;
import com.chronoflow.org.mapper.DepartmentMapper;
import com.chronoflow.org.mapper.OrgMemberMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

/**
 * 新组织的「首位拥有者」预置（spec §3.4 / §6.3 `POST /admin/organizations`）。
 *
 * <p>没有这一步，新组织建出来就是个空壳：后台组织管理员进得去，但组织成员一个都没有，
 * 于是 App 里没有人能认领组织账号、组织日历也没人看得到——只能靠管理员在后台手动
 * 建一个「总部」、再加人。超管建组织时填一个「拥有者唯一识别 ID」，这套动作就一次做完。
 *
 * <p>注意范围：这里**只建根部门和这一条成员记录**，不建账号、不建身份——
 * 身份仍然是成员自己用「组织唯一 ID + 唯一识别 ID」认领时才产生的（spec §3.1）。
 */
@Service
public class OrgBootstrapService {

    /** 预置根部门的名字，与管理端「新建部门」的默认叫法一致，用户一眼能对上。 */
    private static final String ROOT_DEPARTMENT_NAME = "总部";

    private final DepartmentMapper departmentMapper;
    private final OrgMemberMapper orgMemberMapper;

    public OrgBootstrapService(DepartmentMapper departmentMapper, OrgMemberMapper orgMemberMapper) {
        this.departmentMapper = departmentMapper;
        this.orgMemberMapper = orgMemberMapper;
    }

    /**
     * 建根部门 + 首位 OWNER 成员，返回这条成员记录。
     *
     * <p>路径分两步写（先插入拿自增 id，再回填 {@code /id/}）——物化路径的结尾斜杠是硬要求，
     * 少了它 {@code /5} 会误匹配 {@code /51}（spec §6.4）。
     */
    @Transactional
    public OrgMember createRootOwner(Long orgId, String memberKey, String realName) {
        Department root = new Department();
        root.setOrgId(orgId);
        root.setName(ROOT_DEPARTMENT_NAME);
        root.setLevel((short) 1);
        root.setSortOrder(0);
        root.setStatus(Department.STATUS_ACTIVE);
        root.setPath("/");
        departmentMapper.insert(root);
        root.setPath("/" + root.getId() + "/");
        departmentMapper.updateById(root);

        OrgMember owner = new OrgMember();
        owner.setOrgId(orgId);
        owner.setDepartmentId(root.getId());
        owner.setMemberKey(memberKey.trim());
        owner.setRealName(StringUtils.hasText(realName) ? realName.trim() : memberKey.trim());
        owner.setOrgRole(OrgMember.ROLE_OWNER);
        owner.setStatus(OrgMember.STATUS_ACTIVE);
        orgMemberMapper.insert(owner);
        return owner;
    }
}
