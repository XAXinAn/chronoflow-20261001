package com.chronoflow.personal.service;

/**
 * 关键字 → LIKE 模式串（转义 `\`、`%`、`_`，配合 SQL 里的 {@code ESCAPE '\'}）。
 *
 * <p>「全局检索」与「关联日程候选」两处都要用同一条规则：转义规则一旦漂移，
 * 搜「50%」就会变成通配符、命中所有日程 —— 这种错是静默的，谁都不会发现问题。
 */
public final class LikeQuery {

    private LikeQuery() {
    }

    /**
     * 空关键字 → `%%`，配合 `title ILIKE '%%'` 表示「不过滤」（title 非空，必然命中）。
     * 「全部日程」列表就靠这个「同一个 SQL 既能列全部、也能按关键字过滤」。
     */
    public static String pattern(String keyword) {
        String raw = keyword == null ? "" : keyword.trim();
        String escaped = raw
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_");
        return "%" + escaped + "%";
    }
}
