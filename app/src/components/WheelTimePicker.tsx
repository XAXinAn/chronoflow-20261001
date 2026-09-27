import { useMemo } from 'react';

import { composeTime, hours, minutes, parseTimeParts } from '../domain/wheelTime';
import { WheelColumn, WheelRow } from './Wheel';

/**
 * 滚轮式时间选择器（spec §4.1.5）。
 *
 * 编辑页原先让用户手打 `HH:mm`：全键盘上要先切数字、冒号容易漏、光标不好放，
 * 输错了还要等点「保存」才知道格式不对（本机模拟器联调时实测踩到）。
 * 时间与日期一样是「有限取值」，滚轮一拨就到，也不会产生非法值。
 *
 * 分钟列是 1 分钟一档（不是常见的 5 分钟）：日程里「21:28 的会」很常见，
 * 强行整 5 分钟会让用户改成 21:30，然后按错的时间被提醒。
 */
export function WheelTimePicker({
  value,
  onChange,
}: {
  /** `HH:mm`；解析不出时滚轮停在 09:00（见 domain/wheelTime） */
  value: string;
  onChange: (time: string) => void;
}) {
  const { hour, minute } = useMemo(() => parseTimeParts(value), [value]);
  const hourItems = useMemo(
    () => hours().map((item) => ({ key: `h${item}`, label: `${item} 时`, value: item })),
    [],
  );
  const minuteItems = useMemo(
    () => minutes().map((item) => ({ key: `m${item}`, label: `${item} 分`, value: item })),
    [],
  );

  return (
    <WheelRow>
      <WheelColumn
        items={hourItems}
        selectedIndex={hour}
        onSelect={(index) => onChange(composeTime(index, minute))}
        testID="wheel-hour"
      />
      <WheelColumn
        items={minuteItems}
        selectedIndex={minute}
        onSelect={(index) => onChange(composeTime(hour, index))}
        testID="wheel-minute"
      />
    </WheelRow>
  );
}
