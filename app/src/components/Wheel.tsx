import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../context/AppContext';
import { clampIndex, initialWheelOffset } from '../domain/wheelDate';

/**
 * 滚轮控件的最小零件：一列可吸附的选项。
 *
 * 抽出来是因为日期与时间都要用同一套手感（吸附、中间高亮带、松手回弹），
 * 之前只有日期有滚轮、时间是手打输入框，两处体验反而是分裂的。
 */

/** 一行的高度。滚轮靠 snapToInterval 吸附到它的整数倍上。 */
export const ITEM_HEIGHT = 40;
/** 可见行数：中间一行是选中项，上下各一行做视觉引导。 */
export const VISIBLE_ROWS = 3;
export const WHEEL_HEIGHT = ITEM_HEIGHT * VISIBLE_ROWS;

export interface WheelItem {
  key: string;
  label: string;
  value: number;
}

/**
 * 一列滚轮：滚动停止后按偏移量取整吸附到某一行。
 *
 * <p>两个回调都要接：`onScrollEndDrag` 管「慢慢拖一下就松手」（没有惯性，不会触发
 * `onMomentumScrollEnd`），`onMomentumScrollEnd` 管「甩一下让它自己滑」。
 *
 * <p><b>真机上「上滑一次就卡死」的坑（2026-10-01 修）</b>：原来在滚动结束回调里
 * **无条件** `scrollTo({animated: true})`。于是——程序化滚动走完又会回调一次「滚动结束」，
 * 再滚、再回调……**自己滚自己成环**。模拟器上用慢速滑动（没有惯性）调试时完全看不出来，
 * 真机一甩就进死循环，滚轮再也不跟手。
 *
 * 现在设了四道闸，缺一不可：
 * 1. **已经对齐就不滚**（偏移量与行边界相差 &lt; 1px 时什么都不做）——这一条就断了环；
 * 2. **程序化滚动期间忽略滚动结束事件**（`busyRef`，并带超时解锁：
 *    Android 的 `scrollTo(animated)` 结束时不一定回调 `onMomentumScrollEnd`，不能只靠事件解锁）；
 * 3. **甩动时不抢着吸附**（`onScrollEndDrag` 里若还有速度就交给惯性走完）——
 *    在拖拽结束处立刻 `scrollTo` 会掐断惯性，Android 上吸附与惯性互抢，表现为「滚一下就卡」；
 * 4. **同一个下标不重复上报**（`reportedRef`）——否则父组件回传同样的 `selectedIndex`
 *    又会触发上面的 `useEffect` 再滚一次，同样成环。
 */
export function WheelColumn({
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
  /** 最近一次「已知」的目标偏移：用来判断滚轮是不是已经停在该在的位置上 */
  //
  // 初值必须是 **0**（ScrollView 的真实起始位置），不能是 selectedIndex * ITEM_HEIGHT：
  // 后者会让挂载时的「已对齐 → 不用滚」判断为真，首次定位被整个跳过，
  // 滚轮就停在列表第一项（日期列 = 当前年 − 10 = 2016）。见 initialWheelOffset 的注释。
  const offsetRef = useRef(0);
  /** 程序化滚动进行中：这期间收到的滚动结束事件一律忽略（见上面第 2 条闸） */
  const busyRef = useRef(false);
  /** 最近一次上报给外部的下标：同一个值不重复回调（第 4 条闸） */
  const reportedRef = useRef(selectedIndex);
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 首次定位是否已经做过（挂载时只做一次，之后交给外部值变化的那条 effect） */
  const initialisedRef = useRef(false);

  const scrollTo = useCallback((index: number, animated: boolean) => {
    const y = initialWheelOffset(index, ITEM_HEIGHT);
    offsetRef.current = y;
    if (animated) {
      busyRef.current = true;
      if (unlockTimer.current) {
        clearTimeout(unlockTimer.current);
      }
      unlockTimer.current = setTimeout(() => {
        busyRef.current = false;
      }, 360);
    }
    scrollRef.current?.scrollTo({ y, animated });
  }, []);

  /**
   * 挂载后的首次定位：把滚轮**无动画**拨到当前值上。
   *
   * <p>必须等 ScrollView 量完高（`onLayout`）再做：挂载那一瞬间调用 `scrollTo`，
   * Android 上内容还没布局，命令会被丢掉，结果就是「打开还是停在 2016」。
   * 兜底加一个 60ms 的定时器，覆盖 `onLayout` 因平台差异没触发的极端情况。
   */
  const applyInitialPosition = useCallback(() => {
    if (initialisedRef.current) {
      return;
    }
    initialisedRef.current = true;
    reportedRef.current = selectedIndex;
    scrollTo(selectedIndex, false);
  }, [scrollTo, selectedIndex]);

  useEffect(() => {
    const timer = setTimeout(applyInitialPosition, 60);
    return () => clearTimeout(timer);
  }, [applyInitialPosition]);

  useEffect(() => () => {
    if (unlockTimer.current) {
      clearTimeout(unlockTimer.current);
    }
  }, []);

  // 外部值变化（例如点「回到今天」、或月份改变导致天数变化）时把滚轮拨到对应位置
  useEffect(() => {
    setSettledIndex(selectedIndex);
    if (!initialisedRef.current) {
      // 首次挂载交给 applyInitialPosition（等布局完成再滚，避免命令被丢掉）
      return;
    }
    if (Math.abs(offsetRef.current - initialWheelOffset(selectedIndex, ITEM_HEIGHT)) < 1) {
      // 已经在那儿了：再滚一次只会给自己制造一次「滚动结束」事件
      return;
    }
    reportedRef.current = selectedIndex;
    scrollTo(selectedIndex, true);
  }, [scrollTo, selectedIndex]);

  /** 松手 / 惯性结束后对齐到最近一行。 */
  const settle = (offsetY: number, animated: boolean) => {
    const index = clampIndex(offsetY / ITEM_HEIGHT, items.length);
    setSettledIndex(index);
    if (reportedRef.current !== index) {
      reportedRef.current = index;
      onSelect(index);
    }
    const target = index * ITEM_HEIGHT;
    offsetRef.current = target;
    if (Math.abs(offsetY - target) < 1) {
      // 已经落在行边界上：不需要任何补偿滚动（也就不会再有回声）
      return;
    }
    scrollTo(index, animated);
  };

  return (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      style={styles.column}
      contentContainerStyle={styles.columnContent}
      // 首次定位等布局完成后再滚：挂载瞬间 Android 上内容还没量好，scrollTo 会被丢掉
      onLayout={applyInitialPosition}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_HEIGHT}
      decelerationRate="fast"
      nestedScrollEnabled
      onScrollEndDrag={(event) => {
        // 用户又动手了：立刻解除「程序化滚动中」的标记，别把他的操作吞掉
        busyRef.current = false;
        if (unlockTimer.current) {
          clearTimeout(unlockTimer.current);
        }
        // 有速度就交给惯性（`onMomentumScrollEnd` 再对齐）：在拖拽结束处抢着吸附会掐断惯性
        const velocity = event.nativeEvent.velocity?.y ?? 0;
        if (Math.abs(velocity) > 0.05) {
          return;
        }
        settle(event.nativeEvent.contentOffset.y, true);
      }}
      onMomentumScrollEnd={(event) => {
        if (busyRef.current) {
          // 这是我们自己发起的滚动，忽略它带来的「结束」回调
          return;
        }
        // 惯性已经停住：直接对齐，不再起一段动画
        settle(event.nativeEvent.contentOffset.y, false);
      }}
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

/** 中间高亮带：告诉用户「停在谁身上就是选谁」。 */
export function WheelBand() {
  const theme = useAppTheme();
  return (
    <View
      pointerEvents="none"
      style={[
        styles.band,
        {
          borderColor: theme.color.border,
          backgroundColor: theme.color.surface,
          top: (WHEEL_HEIGHT - ITEM_HEIGHT) / 2,
        },
      ]}
    />
  );
}

/** 多列滚轮的容器：负责铺高亮带与横向排布。 */
export function WheelRow({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.container}>
      <WheelBand />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', height: WHEEL_HEIGHT, position: 'relative' },
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
  columnContent: { paddingVertical: (WHEEL_HEIGHT - ITEM_HEIGHT) / 2 },
  item: { height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
});
