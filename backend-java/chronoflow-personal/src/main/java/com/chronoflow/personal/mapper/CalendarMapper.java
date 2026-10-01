package com.chronoflow.personal.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.personal.entity.Calendar;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface CalendarMapper extends BaseMapper<Calendar> {
}
