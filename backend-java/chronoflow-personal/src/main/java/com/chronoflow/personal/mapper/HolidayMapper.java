package com.chronoflow.personal.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.personal.entity.Holiday;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Insert;
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

    /**
     * 按唯一键 upsert 一条节假日/调休。
     *
     * <p>定时同步与手动脚本走的是同一条写入路径的语义：**重复执行是「更正」，不是「再插一条」**。
     * 靠 `ON CONFLICT` 而不是「先查再决定插还是改」，是为了并发下也不会写出重复行。
     */
    @Insert("""
            INSERT INTO holiday (country_code, holiday_date, name, day_type)
            VALUES (#{country}, CAST(#{date} AS date), #{name}, #{dayType})
            ON CONFLICT (country_code, holiday_date)
            DO UPDATE SET name = EXCLUDED.name,
                          day_type = EXCLUDED.day_type,
                          updated_at = now()
            """)
    int upsert(@Param("country") String country,
               @Param("date") LocalDate date,
               @Param("name") String name,
               @Param("dayType") String dayType);
}
