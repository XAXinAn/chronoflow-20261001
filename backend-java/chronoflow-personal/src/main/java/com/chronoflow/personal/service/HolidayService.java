package com.chronoflow.personal.service;

import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.personal.dto.HolidayDtos.HolidayItem;
import com.chronoflow.personal.dto.HolidayDtos.HolidayResponse;
import com.chronoflow.personal.mapper.HolidayMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 节假日与调休（spec §5.11）。
 *
 * <p>数据全在 {@code holiday} 表里，由 {@code scripts/load_holidays.py} 灌入；这里只负责读与缓存。
 * 需求是「支持后续热更新节假日数据」（spec §4.1.2），所以刻意**不把数据放代码里**：
 * 换一年、按官方通知更正一个调休日，都只是数据变更，不需要发版，也不需要重启——
 * 进程内缓存最多陈旧一个 TTL。
 */
@Service
public class HolidayService {

    private static final String DEFAULT_COUNTRY = "zh-CN";
    private static final int MIN_YEAR = 1970;
    private static final int MAX_YEAR = 2100;

    private final HolidayMapper holidayMapper;
    private final Duration cacheTtl;
    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();

    public HolidayService(HolidayMapper holidayMapper,
                          @Value("${chronoflow.holiday.cache-ttl:5m}") Duration cacheTtl) {
        this.holidayMapper = holidayMapper;
        this.cacheTtl = cacheTtl;
    }

    /**
     * 取某国家日历某年（或某年某月）的节假日与调休。
     *
     * @param month 为 null 时返回全年
     */
    public HolidayResponse query(String country, Integer year, Integer month) {
        if (year == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "year 不能为空");
        }
        if (year < MIN_YEAR || year > MAX_YEAR) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "year 超出有效范围");
        }
        if (month != null && (month < 1 || month > 12)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "month 必须在 1-12 之间");
        }
        String normalized = normalizeCountry(country);

        String key = normalized + '|' + year + '|' + (month == null ? "all" : month);
        CacheEntry cached = cache.get(key);
        Instant now = Instant.now();
        if (cached != null && cached.expiresAt().isAfter(now)) {
            return new HolidayResponse(normalized, year, month, cached.days());
        }

        LocalDate from = month == null ? LocalDate.of(year, 1, 1) : LocalDate.of(year, month, 1);
        LocalDate to = month == null ? from.plusYears(1) : from.plusMonths(1);
        List<HolidayItem> days = holidayMapper.selectInRange(normalized, from, to).stream()
                .map(holiday -> new HolidayItem(holiday.getHolidayDate(), holiday.getName(), holiday.getDayType()))
                .toList();
        cache.put(key, new CacheEntry(now.plus(cacheTtl), days));
        return new HolidayResponse(normalized, year, month, days);
    }

    /**
     * 清空进程内缓存。
     *
     * <p>数据热更新后想立刻生效就可以调它——不调也没关系，最多等一个 TTL。
     */
    public void clearCache() {
        cache.clear();
    }

    /** 国家日历标识归一化：`zh-cn`、`ZH-CN` 都当 `zh-CN`，避免大小写不同查不到数据。 */
    private static String normalizeCountry(String country) {
        if (country == null || country.isBlank()) {
            return DEFAULT_COUNTRY;
        }
        String trimmed = country.trim();
        int dash = trimmed.indexOf('-');
        if (dash < 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "country 需形如 zh-CN");
        }
        String language = trimmed.substring(0, dash).toLowerCase(Locale.ROOT);
        String region = trimmed.substring(dash + 1).toUpperCase(Locale.ROOT);
        if (language.isEmpty() || region.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "country 需形如 zh-CN");
        }
        return language + '-' + region;
    }

    /** 缓存条目：内容 + 过期时刻。TTL 到期后重新读库，数据热更新最迟一个 TTL 生效。 */
    private record CacheEntry(Instant expiresAt, List<HolidayItem> days) {
    }
}
