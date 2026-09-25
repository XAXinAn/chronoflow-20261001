import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../context/AppContext';
import {
  buildYearRange,
  clampIndex,
  composeDateKey,
  daysOfMonth,
  months,
  parseDateKey,
  YEAR_SPAN,
} from '../domain/wheelDate';

/** 一行的高度。滚轮靠 snapToInterval 吸附到它的整数倍上。 */
const ITEM_HEIGHT = 40;
/** 可见行数：中间一行是选中项，上下各一行做视觉引导。 */
const VISIBLE_ROWS = 3;
const HEIGHT = ITEM_HEIGHT * VISIBLE_ROWS;

/**
 * 滚轮式日期选择器（spec §4.1.7「跳到指定日期」）。
 *
 * <p>为什么自己写：Expo Go 里没有现成的滚轮控件（`@react-native-picker/picker` 在 Android 上是
 * 对话框/下拉，不是滚轮），而「跳到指定日期」要的正是滚轮那种快速拨动的感觉。
 * 实现用「吸附式 ScrollView + 中间高亮带」，没有任何原生依赖。
 */
export function WheelDatePicker({
  value,
  onChange,
  minYear,
  maxYear,
}: {
  /** 当前选中的日期键（YYYY-MM-DD） */
  value: string;
  onChange: (dateKey: string) => void;
  minYear?: number;
  maxYear?: number;
}) {
  const theme = useAppTheme();
  const { year, month, day } = useMemo(() => parseDateKey(value), [value]);
  const years = useMemo(() => {
    const range = buildYearRange(year, YEAR_SPAN);
    return range.filter((item) => (minYear === undefined || item >= minYear)
      && (maxYear === undefined || item <= maxYear));
  }, [year, minYear, maxYear]);
  const days = useMemo(() => daysOfMonth(year, month), [year, month]);

  const pick = useCallback(
    (nextYear: number, nextMonth: number, nextDay: number) => {
      const next = composeDateKey(nextYear, nextMonth, nextDay);
      if (next !== value) {
        onChange(next);
      }
    },
    [onChange, value],
  );

  return (
    <View style={styles.container}>
      {/* 中间高亮带：告诉用户「停在谁身上就是选谁」 */}
      <View
        pointerEvents="none"
        style={[
          styles.band,
          {
            borderColor: theme.color.border,
            backgroundColor: theme.color.surface,
            top: (HEIGHT - ITEM_HEIGHT) / 2,
          },
        ]}
      />

      <WheelColumn
        items={years.map((item) => ({ key: String(item), label: `${item} 年`, value: item }))}
        selectedIndex={years.indexOf(year)}
        onSelect={(index) => pick(years[index], month, day)}
        testID="wheel-year"
      />
      <WheelColumn
        items={months().map((item) => ({ key: String(item), label: `${item} 月`, value: item }))}
        selectedIndex={month - 1}
        onSelect={(index) => pick(year, months()[index], day)}
        testID="wheel-month"
      />
      <WheelColumn
        items={days.map((item) => ({ key: String(item), label: `${item} 日`, value: item }))}
        selectedIndex={day - 1}
        onSelect={(index) => pick(year, month, days[index])}
        testID="wheel-day"
      />
    </View>
  );
}

interface WheelItem {
  key: string;
  label: string;
  value: number;
}

/**
 * 一列滚轮：滚动停止后按偏移量取整吸附到某一行。
 *
 * <p>两个回调都要接：`onScrollEndDrag` 管「慢慢拖一下就松手」（没有惯性，不会触发
 * `onMomentumScrollEnd`），`onMomentumScrollEnd` 管「甩一下让它自己滑」。
 */
function WheelColumn({
  items,
  selectedIndex,
  onSelect,
  testID,
}: {
  items: WheelItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  testID?: string;
}) {
  const theme = useAppTheme();
  const scrollRef = useRef<ScrollView>(null);
  const [settledIndex, setSettledIndex] = useState(selectedIndex);

  // 外部值变化（例如点「回到今天」、或月份改变导致天数变化）时把滚轮拨到对应位置
  useEffect(() => {
    setSettledIndex(selectedIndex);
    scrollRef.current?.scrollTo({ y: selectedIndex * ITEM_HEIGHT, animated: true });
  }, [selectedIndex]);

  const commit = (offsetY: number) => {
    const index = clampIndex(offsetY / ITEM_HEIGHT, items.length);
    scrollRef.current?.scrollTo({ y: index * ITEM_HEIGHT, animated: true });
    setSettledIndex(index);
    onSelect(index);
  };

  return (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      style={styles.column}
      contentContainerStyle={styles.columnContent}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_HEIGHT}
      decelerationRate="fast"
      nestedScrollEnabled
      onScrollEndDrag={(event) => commit(event.nativeEvent.contentOffset.y)}
      onMomentumScrollEnd={(event) => commit(event.nativeEvent.contentOffset.y)}
    >
      {items.map((item, index) => {
        const selected = index === settledIndex;
        return (
          <View key={item.key} style={styles.item}>
            <Text
              style={{
                fontSize: selected ? 18 : 15,
                fontWeight: selected ? '600' : '400',
                color: selected ? theme.color.textPrimary : theme.color.textTertiary,
              }}
            >
              {item.label}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', height: HEIGHT, position: 'relative' },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: ITEM_HEIGHT,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
  },
  column: { flex: 1 },
  columnContent: { paddingVertical: (HEIGHT - ITEM_HEIGHT) / 2 },
  item: { height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
});
