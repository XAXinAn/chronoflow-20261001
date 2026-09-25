import { Pressable, StyleSheet, Text, View } from 'react-native';

import { WEEKDAY_LABELS, buildMonthGrid, monthLabel, shiftMonth } from '../domain/calendar';
import { holidayBadge, type HolidayMark } from '../domain/holiday';
import { useAppTheme } from '../context/AppContext';

interface MonthCalendarProps {
  year: number;
  month: number;
  selectedDateKey: string;
  todayKey: string;
  /** 有日程的日期集合（YYYY-MM-DD） */
  eventDates: Set<string>;
  /**
   * 节假日与调休标记（spec §4.1.2 / §5.11）：日期 → 放假 / 调休上班。
   * 库里没有那一年就是一个空表——不猜、不硬编码兜底。
   */
  holidayMarks?: Map<string, HolidayMark>;
  onSelectDate: (dateKey: string) => void;
  onChangeMonth: (year: number, month: number) => void;
  /**
   * 「今天」快捷键：一键回到今天所在月份并选中今天。
   *
   * <p>它是日历页最高频的动作，之所以单独放在月历头部而不是塞进「跳到指定日期」里——
   * 翻了几个月之后想回来，不该先点开一个面板。
   */
  onToday?: () => void;
}

/**
 * 月视图日历（spec §7.6：黑白极简）。
 *
 * 选中态用实心圆 + 反色文字；今天用描边；有日程用底部小圆点。
 * 全程不使用彩色——日程密度靠点数量而非颜色表达。
 */
export function MonthCalendar({
  year,
  month,
  selectedDateKey,
  todayKey,
  eventDates,
  holidayMarks,
  onSelectDate,
  onChangeMonth,
  onToday,
}: MonthCalendarProps) {
  const theme = useAppTheme();
  const grid = buildMonthGrid(year, month);
  const previous = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const viewingToday = selectedDateKey === todayKey;

  return (
    <View>
      <View style={styles.header}>
        {/*
          三栏布局：左「今天」、中间「‹ 月份 ›」、右侧等宽占位。
          右侧不留等宽占位的话，左边多了个按钮就会把标题顶偏；
          而把「今天」绝对定位到左侧更糟——它会直接压在上一月的箭头上（踩过）。
        */}
        <View style={styles.headerSide}>
          {onToday ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="回到今天"
              onPress={onToday}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text
                style={{
                  fontSize: 13,
                  // 已经在今天时变灰：一眼能看出「现在就是今天」，不再需要点
                  color: viewingToday ? theme.color.textTertiary : theme.color.accent,
                  fontWeight: '600',
                }}
              >
                今天
              </Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.headerNav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="上个月"
            hitSlop={12}
            onPress={() => onChangeMonth(previous.year, previous.month)}
          >
            <Text style={[styles.nav, { color: theme.color.textSecondary }]}>‹</Text>
          </Pressable>

          <Text style={[styles.title, { color: theme.color.textPrimary }]}>
            {monthLabel(year, month)}
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="下个月"
            hitSlop={12}
            onPress={() => onChangeMonth(next.year, next.month)}
          >
            <Text style={[styles.nav, { color: theme.color.textSecondary }]}>›</Text>
          </Pressable>
        </View>

        <View style={styles.headerSide} />
      </View>

      <View style={styles.weekdayRow}>
        {WEEKDAY_LABELS.map((label) => (
          <View key={label} style={styles.cell}>
            <Text style={[styles.weekday, { color: theme.color.textTertiary }]}>{label}</Text>
          </View>
        ))}
      </View>

      {grid.weeks.map((week, weekIndex) => (
        <View key={weekIndex} style={styles.weekRow}>
          {week.map((cell) => {
            const selected = cell.dateKey === selectedDateKey;
            const isToday = cell.dateKey === todayKey;
            const hasEvents = eventDates.has(cell.dateKey);
            const badge = holidayBadge(holidayMarks?.get(cell.dateKey));

            const textColor = selected
              ? theme.color.accentContrast
              : cell.inMonth
                ? theme.color.textPrimary
                : theme.color.textTertiary;

            const accessibilityParts = [cell.dateKey];
            if (hasEvents) {
              accessibilityParts.push('有日程');
            }
            if (badge === '休') {
              accessibilityParts.push('放假');
            }
            if (badge === '班') {
              accessibilityParts.push('调休上班');
            }

            return (
              <Pressable
                key={cell.dateKey}
                style={styles.cell}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={accessibilityParts.join(' ')}
                onPress={() => onSelectDate(cell.dateKey)}
              >
                <View style={styles.dayWrap}>
                  <View
                    style={[
                      styles.dayCircle,
                      {
                        backgroundColor: selected ? theme.color.accent : 'transparent',
                        borderColor: isToday && !selected ? theme.color.accent : 'transparent',
                      },
                    ]}
                  >
                    <Text style={[styles.dayText, { color: textColor }]}>{cell.day}</Text>
                  </View>
                  {/* 休 / 班 挂在数字右上角：放假蓝、调休红，一眼能扫出来 */}
                  {badge ? (
                    <Text
                      style={[
                        styles.holidayBadge,
                        { color: badge === '休' ? theme.color.holiday : theme.color.workday },
                      ]}
                    >
                      {badge}
                    </Text>
                  ) : null}
                </View>
                <View
                  style={[
                    styles.dot,
                    {
                      backgroundColor: hasEvents
                        ? selected
                          ? theme.color.accentContrast
                          : theme.color.textTertiary
                        : 'transparent',
                    },
                  ]}
                />
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    marginBottom: 8,
  },
  /** 左右两栏等宽：中间那组才真正居中 */
  headerSide: { width: 52, alignItems: 'flex-start' },
  headerNav: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  nav: { fontSize: 26, lineHeight: 30, paddingHorizontal: 8 },
  weekdayRow: { flexDirection: 'row', marginBottom: 4 },
  weekRow: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 3 },
  weekday: { fontSize: 12 },
  dayCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: { fontSize: 15 },
  dayWrap: { position: 'relative' },
  dot: { width: 4, height: 4, borderRadius: 2, marginTop: 2 },
  holidayBadge: {
    position: 'absolute',
    top: -4,
    right: -7,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
  },
});
