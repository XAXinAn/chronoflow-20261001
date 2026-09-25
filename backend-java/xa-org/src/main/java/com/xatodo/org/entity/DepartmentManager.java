package com.xatodo.org.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 部门管理员授权：一个成员可被授权管理多个部门，权限范围为「该部门 + 所有下级部门」。
 */
@TableName("department_manager")
public class DepartmentManager {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long departmentId;

    private Long orgMemberId;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getDepartmentId() {
        return departmentId;
    }

    public void setDepartmentId(Long departmentId) {
        this.departmentId = departmentId;
    }

    public Long getOrgMemberId() {
        return orgMemberId;
    }

    public void setOrgMemberId(Long orgMemberId) {
        this.orgMemberId = orgMemberId;
    }
}
