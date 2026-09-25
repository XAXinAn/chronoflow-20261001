package com.xatodo.personal.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xatodo.personal.entity.Holiday;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.time.LocalDate;
import java.util.List;

@Mapper
public interface HolidayMapper extends BaseMapper<Holiday> {

    /**
     * 取某国家日历在 [from, to) 内的节假日与调休，按日期升序。
     *
     * <p>用半开区间：`< to` 比 `<= 12-31` 更不容易在跨年时写错一天。
     */
    @Select("""
            SELECT id, country_code, holiday_date, name, day_type, created_at, updated_at
            FROM holiday
            WHERE country_code = #{country}
              AND holiday_date >= #{from}
              AND holiday_date < #{to}
            ORDER BY holiday_date
            """)
    List<Holiday> selectInRange(@Param("country") String country,
                                @Param("from") LocalDate from,
                                @Param("to") LocalDate to);
}
