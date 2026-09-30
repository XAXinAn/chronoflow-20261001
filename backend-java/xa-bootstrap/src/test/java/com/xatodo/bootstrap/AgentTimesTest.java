package com.xatodo.bootstrap;

import com.xatodo.agent.tool.AgentTimes;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.ZoneId;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 模型给的时间字符串怎么解析（spec §11 阶段三）。
 *
 * <p>下面这些形状都是从**真实上游**抓下来的：模型很少给带偏移量的 ISO 串，
 * 最常见的是 `2026-09-28 15:00`（空格分隔、没有时区）。解析不了就得按「缺时间」处理，
 * 否则会把日程建到错误的时刻上——这种错用户要过一天才会发现。
 */
class AgentTimesTest {

    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    @Test
    @DisplayName("带偏移量的 ISO 串按原样解析")
    void parsesOffsetDateTime() {
        assertThat(AgentTimes.parse("2026-09-28T15:00:00+08:00", ZONE).toString())
                .isEqualTo("2026-09-28T07:00:00Z");
    }

    @Test
    @DisplayName("模型最常给的「日期 空格 时间」按请求时区补偏移量")
    void parsesLocalDateTimeWithSpace() {
        assertThat(AgentTimes.parse("2026-09-28 15:00", ZONE).toString())
                .isEqualTo("2026-09-28T07:00:00Z");
    }

    @Test
    @DisplayName("只有日期 = 当天 00:00（只说了哪一天）")
    void parsesDateOnly() {
        assertThat(AgentTimes.parse("2026-09-28", ZONE).toString()).isEqualTo("2026-09-27T16:00:00Z");
    }

    @Test
    @DisplayName("看不懂的字符串返回 null，由调用方按「缺信息」处理而不是瞎猜")
    void unparsableReturnsNull() {
        assertThat(AgentTimes.parse("明天下午三点", ZONE)).isNull();
        assertThat(AgentTimes.parse("", ZONE)).isNull();
        assertThat(AgentTimes.parse(null, ZONE)).isNull();
    }

    @Test
    @DisplayName("给人看的展示文案：有具体时刻就带时刻，只说哪天就只给日期（没有「全天」这个词）")
    void formatsPointForHumans() {
        assertThat(AgentTimes.formatPoint(
                AgentTimes.parse("2026-09-28 15:00", ZONE), ZONE)).isEqualTo("9/28 15:00");
        assertThat(AgentTimes.formatPoint(
                AgentTimes.parse("2026-09-28", ZONE), ZONE)).isEqualTo("9/28");
    }
}
