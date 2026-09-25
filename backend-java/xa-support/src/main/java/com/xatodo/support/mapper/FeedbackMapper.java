package com.xatodo.support.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xatodo.support.entity.Feedback;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface FeedbackMapper extends BaseMapper<Feedback> {
}
