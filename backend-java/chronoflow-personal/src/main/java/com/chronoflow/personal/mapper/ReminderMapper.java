package com.chronoflow.personal.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.personal.entity.Reminder;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface ReminderMapper extends BaseMapper<Reminder> {
}
