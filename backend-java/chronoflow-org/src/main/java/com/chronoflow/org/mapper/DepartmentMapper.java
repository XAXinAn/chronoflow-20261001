package com.chronoflow.org.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.org.entity.Department;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface DepartmentMapper extends BaseMapper<Department> {
}
