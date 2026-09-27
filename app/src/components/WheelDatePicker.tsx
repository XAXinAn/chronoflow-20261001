import { useCallback, useMemo } from 'react';

import {
  buildYearRange,
  composeDateKey,
  daysOfMonth,
  months,
  parseDateKey,
  YEAR_SPAN,
} from '../domain/wheelDate';
import { WheelColumn, WheelRow } from './Wheel';

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
    <WheelRow>
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
    </WheelRow>
  );
}
