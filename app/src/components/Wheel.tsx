import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../context/AppContext';
import { clampIndex } from '../domain/wheelDate';

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
