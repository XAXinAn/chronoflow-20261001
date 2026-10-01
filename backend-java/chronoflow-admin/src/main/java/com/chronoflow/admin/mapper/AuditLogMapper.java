package com.chronoflow.admin.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.admin.entity.AuditLog;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface AuditLogMapper extends BaseMapper<AuditLog> {
}
