package com.chronoflow.org.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.org.entity.Organization;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface OrganizationMapper extends BaseMapper<Organization> {
}
