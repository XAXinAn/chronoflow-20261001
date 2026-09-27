import { isRunningInExpoGo } from 'expo';
import { Platform } from 'react-native';

/**
 * 本机能不能用 `expo-notifications`（spec §4.5）。
 *
 * **Android 的 Expo Go 从 SDK 53 起移除了这个模块**：`import('expo-notifications')`
 * 会在模块求值阶段直接抛错，而且这个错是模块工厂自己报的 —— 调用方 `catch` 也拦不住
 * LogBox 的红框。所以每个 import 点都要先用它挡一道。
 *
 * 判据照抄库内部的 `warnOfExpoGoPushUsage`：`isRunningInExpoGo()` + Android。
 * **不要**用 `Constants.executionEnvironment === 'storeClient'`：那个值对
 * 「Expo Go」和「expo-dev-client 开发构建」都是 `storeClient`，用它会把开发构建里的
 * 通知能力一起关掉 —— 而开发构建正是验证「到点真的会响」的唯一环境。
 *
 * iOS 的 Expo Go 只是降级（本地通知仍可用），所以不带平台判断会误伤。
 */
export function localNotificationsAvailable(): boolean {
  return !(Platform.OS === 'android' && isRunningInExpoGo());
}
