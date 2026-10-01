package com.chronoflow.personal.service;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.personal.entity.Holiday;
import com.chronoflow.personal.holiday.HolidaySource;
import com.chronoflow.personal.mapper.HolidayMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

/**
 * 节假日数据自动同步（spec §5.11）。
 *
 * <p>每天从 holiday-cn 拉当年与次年的数据，幂等 upsert 进 holiday 表并清缓存。
 * 为什么要有它：放假安排每年都在变（还会中途更正调休），靠人记得去跑脚本迟早会漏；
 * 数据量只有几十条、上游一年动几次，每天跑一次的代价可以忽略，但能把「忘了更新」直接消掉。
 *
 * <p>几条刻意的设计：
 * <ul>
 *   <li><b>永不抛异常</b>：上游抖动不该影响服务本身，失败只记状态 + 告警，界面继续用库里已有的数据；</li>
 *   <li><b>先全解析再写库</b>：某一年数据格式变了就整年跳过，不写半截——半截数据比旧数据更难排查；</li>
 *   <li><b>次年是 404 属正常</b>：国务院办公厅通常当年 11 月才发次年通知，没发布就跳过；</li>
 *   <li><b>同步完清缓存</b>：否则会变成「库里更新了、界面还是旧的」。</li>
 * </ul>
 */
@Service
public class HolidaySyncService {

    private static final Logger log = LoggerFactory.getLogger(HolidaySyncService.class);
    private static final String COUNTRY = "zh-CN";
    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    private final HolidaySource source;
    private final HolidayMapper holidayMapper;
    private final HolidayService holidayService;
    private final HolidaySyncStatus status;
    private final ObjectMapper objectMapper;

    public HolidaySyncService(HolidaySource source,
                              HolidayMapper holidayMapper,
                              HolidayService holidayService,
                              HolidaySyncStatus status,
                              ObjectMapper objectMapper) {
        this.source = source;
        this.holidayMapper = holidayMapper;
        this.holidayService = holidayService;
        this.status = status;
        this.objectMapper = objectMapper;
    }

    /** 同步当年 + 次年。任何失败都只记录状态，不向外抛。 */
    public void syncOnce() {
        OffsetDateTime now = OffsetDateTime.now(ZONE);
        int currentYear = now.getYear();
        int days = 0;
        List<Integer> synced = new ArrayList<>();
        List<String> failures = new ArrayList<>();

        for (int year : List.of(currentYear, currentYear + 1)) {
            try {
                String raw = source.fetch(year);
                if (raw == null) {
                    continue;
                }
                int applied = apply(raw, year);
                if (applied == 0) {
                    // 上游会给次年先建一个 days 为空的占位文件，别把它算进「已同步」里自欺欺人
                    log.info("{} 年的上游文件已存在但还没有放假安排，本次跳过", year);
                    continue;
                }
                days += applied;
                synced.add(year);
            } catch (Exception ex) {
                // 单独一年的失败不影响另一年：次年的格式变了不该拦住当年的更正
                failures.add(year + " 年：" + ex.getMessage());
                log.warn("同步 {} 年节假日失败：{}", year, ex.toString());
            }
        }

        // 清缓存是必须的：否则库里更新了、界面还要等一个 TTL 才变，看起来就是「同步没生效」
        holidayService.clearCache();

        if (failures.isEmpty()) {
            status.recordSuccess(now, days, synced);
            log.info("节假日同步完成：写入/更新 {} 条（{}），来源 {}",
                    days, synced, source.getClass().getSimpleName());
        } else {
            status.recordFailure(now, String.join("；", failures));
        }
    }

    /**
     * 解析一年数据 → 全部校验通过后才写库。
     *
     * <p>先解析成中间结构再落库，避免「第 5 条日期非法」时前 4 条已经写进去了。
     */
    private int apply(String raw, int expectedYear) throws IOException {
        HolidayFile file = objectMapper.readValue(raw, HolidayFile.class);
        if (file.year() != null && file.year() != expectedYear) {
            throw new IOException("上游返回的年份不匹配：" + file.year() + " ≠ " + expectedYear);
        }
        List<HolidayFile.Day> days = file.days() == null ? List.of() : file.days();
        List<Row> rows = new ArrayList<>(days.size());
        for (HolidayFile.Day day : days) {
            if (day.date() == null || day.name() == null || day.name().isBlank()) {
                throw new IOException("上游数据缺少日期或名称：" + day);
            }
            rows.add(new Row(
                    LocalDate.parse(day.date()),
                    day.name().trim(),
                    Boolean.TRUE.equals(day.isOffDay()) ? Holiday.TYPE_HOLIDAY : Holiday.TYPE_WORKDAY));
        }
        for (Row row : rows) {
            holidayMapper.upsert(COUNTRY, row.date(), row.name(), row.type());
        }
        return rows.size();
    }

    private record Row(LocalDate date, String name, String type) {
    }

    /** holiday-cn 的原始格式；只取要用的字段，其余（$schema / papers 等）忽略。 */
    @JsonIgnoreProperties(ignoreUnknown = true)
    private record HolidayFile(Integer year, List<String> papers, List<Day> days) {

        @JsonIgnoreProperties(ignoreUnknown = true)
        private record Day(String name, String date,
                           // 不加这个注解，Jackson 会把 isOffDay 认成 offDay，字段就永远读不到
                           @JsonProperty("isOffDay") Boolean isOffDay) {
        }
    }
}
