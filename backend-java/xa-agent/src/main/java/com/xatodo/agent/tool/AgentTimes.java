package com.xatodo.agent.tool;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;

/**
 * 解析模型给的时间字符串。
 *
 * <p>模型给的形式很杂：带偏移量的完整时间、不带偏移量的「日期 时间」、只有日期
 * （视为「就这一天」）、以及纯数字时间戳。「明天下午三点」这种相对时间不在这里算，
 * 靠系统提示里的「今天是几号」让模型自己换算成绝对时间。
 *
 * <p>实在解析不了就返回 null，由调用方决定是「先问用户」还是当参数非法。
 */
public final class AgentTimes {

    /** 给人看的短时间：9/28 15:00。 */
    public static final DateTimeFormatter SHORT = DateTimeFormatter.ofPattern("M/d HH:mm");
    /** 给人看的短日期：9/28。 */
    public static final DateTimeFormatter SHORT_DATE = DateTimeFormatter.ofPattern("M/d");

    private AgentTimes() {
    }

    public static Instant parse(String raw, ZoneId zone) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String value = raw.trim();
        try {
            return OffsetDateTime.parse(value).toInstant();
        } catch (DateTimeParseException ignored) {
            // 继续尝试下面几种
        }
        try {
            return LocalDateTime.parse(value.replace(' ', 'T')).atZone(zone).toInstant();
        } catch (DateTimeParseException ignored) {
            // 再试「只有日期」的形式（只说了哪一天）
        }
        try {
            return LocalDate.parse(value).atStartOfDay(zone).toInstant();
        } catch (DateTimeParseException ignored) {
            // 纯数字时间戳（有些模型会这么返回）
        }
        try {
            return Instant.ofEpochSecond(Long.parseLong(value));
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    public static String format(Instant instant, ZoneId zone) {
        return SHORT.format(instant.atZone(zone));
    }

    /**
     * 单时间点的展示。
     *
     * <p>落在当地 00:00 的表示「只说了哪天、没说几点」（spec §4.1.2），只给日期；
     * 其余给「9/28 15:00」。**没有「全天」这个词**——那本来是我们自己造的概念。
     */
    public static String formatPoint(Instant at, ZoneId zone) {
        ZonedDateTime local = at.atZone(zone);
        if (local.getHour() == 0 && local.getMinute() == 0) {
            return SHORT_DATE.format(local);
        }
        return format(at, zone);
    }
}
