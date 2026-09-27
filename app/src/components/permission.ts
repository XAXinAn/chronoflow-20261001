import { Alert, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';

import {
  ensurePermission,
  permissionRationale,
  type PermissionKind,
  type PermissionGateway,
} from '../domain/permissions';

/**
 * 权限申请的 RN 适配层：把 domain/permissions.ts 的纯逻辑接到真实的系统弹窗上。
 *
 * 所有申请相机 / 相册 / 定位的地方都必须走这里，**不要再直接调
 * `ImagePicker.requestCameraPermissionsAsync()`**——那样就绕过了「先说明用途」这一步，
 * 而审核规范把「未及时明确告知索取权限的目的和用途」列为常见违规。
 */
export async function askPermission(
  kind: PermissionKind,
  options: { quiet?: boolean } = {},
): Promise<boolean> {
  const rationale = permissionRationale(kind);

  const explain = () =>
    new Promise<boolean>((resolve) => {
      Alert.alert(rationale.title, rationale.message, [
        { text: '不允许', style: 'cancel', onPress: () => resolve(false) },
        { text: '继续', onPress: () => resolve(true) },
      ]);
    });

  const reject = () => {
    // 拒绝后只提示，绝不退出 App，也不再反复弹窗（规范 §四「不给权限 APP 弹窗循环」）
    Alert.alert('未开启权限', rationale.deniedHint, [
      { text: '知道了', style: 'cancel' },
      // 已经被系统记住「不再询问」时，唯一的补救路径是去系统设置，主动给一个入口
      { text: '去设置', onPress: () => void Linking.openSettings() },
    ]);
  };

  const gateway = gatewayFor(kind, explain, reject);
  if (options.quiet && !(await gateway.current())) {
    // 「静默尝试」场景（比如刚进地点选择页时顺手定位一下）：
    // 没授权就直接放弃，不弹任何窗——进来就弹一个权限说明正是「频繁弹窗」的典型形态
    return false;
  }
  return ensurePermission(gateway);
}

function gatewayFor(
  kind: PermissionKind,
  explain: () => Promise<boolean>,
  reject: () => void,
): PermissionGateway {
  if (kind === 'location') {
    return {
      current: async () => (await Location.getForegroundPermissionsAsync()).granted,
      request: async () => (await Location.requestForegroundPermissionsAsync()).granted,
      explain,
      reject,
    };
  }
  return {
    current: async () => (await ImagePicker.getMediaLibraryPermissionsAsync()).granted,
    request: async () => (await ImagePicker.requestMediaLibraryPermissionsAsync()).granted,
    explain,
    reject,
  };
}
