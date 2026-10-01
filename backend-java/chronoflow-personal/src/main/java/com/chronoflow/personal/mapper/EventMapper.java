package com.chronoflow.personal.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.personal.entity.Event;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;

@Mapper
public interface EventMapper extends BaseMapper<Event> {

    /**
     * 查询与区间可能相交的日程：非重复日程按区间相交，重复日程按其序列是否延伸到区间之后判断。
     */
    List<Event> selectInRange(@Param("calendarIds") Collection<Long> calendarIds,
                              @Param("rangeStart") OffsetDateTime rangeStart,
                              @Param("rangeEnd") OffsetDateTime rangeEnd);
}
