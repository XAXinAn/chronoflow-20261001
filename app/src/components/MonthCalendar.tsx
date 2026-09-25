import { Pressable, StyleSheet, Text, View } from 'react-native';

import { WEEKDAY_LABELS, buildMonthGrid, monthLabel, shiftMonth } from '../domain/calendar';
import { useAppTheme } from '../context/AppContext';

interface MonthCalendarProps {
  year: number;
  month: number;
  selectedDateKey: string;
  todayKey: string;
  /** 有日程的日期集合（YYYY-MM-DD） */
  eventDates: Set<string>;
  onSelectDate: (dateKey: string) => void;
  onChangeMonth: (year: number, month: number) => void;
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
  onSelectDate,
  onChangeMonth,
}: MonthCalendarProps) {
  const theme = useAppTheme();
  const grid = buildMonthGrid(year, month);
  const previous = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);

  return (
    <View>
      <View style={styles.header}>
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

            const textColor = selected
              ? theme.color.accentContrast
              : cell.inMonth
                ? theme.color.textPrimary
                : theme.color.textTertiary;

            return (
              <Pressable
                key={cell.dateKey}
                style={styles.cell}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${cell.dateKey}${hasEvents ? ' 有日程' : ''}`}
                onPress={() => onSelectDate(cell.dateKey)}
              >
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
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    marginBottom: 8,
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
  dot: { width: 4, height: 4, borderRadius: 2, marginTop: 2 },
});
