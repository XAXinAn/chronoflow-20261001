package com.xatodo.personal.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xatodo.personal.entity.Task;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface TaskMapper extends BaseMapper<Task> {
}
