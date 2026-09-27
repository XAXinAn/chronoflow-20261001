/**
 * 权限申请的统一入口（spec §12；审核规范 §四「APP 频繁、过度索取权限」）。
 *
 * 审核明确的三个雷区，这里逐个对应：
 * 1. 「未及时明确告知用户索取权限的目的和用途」→ 申请前**先用我们自己的文案解释**，
 *    而不是直接把系统弹窗甩给用户；
 * 2. 「用户拒绝权限申请后强制退出或关闭 APP」→ 拒绝时只提示、**绝不退出**，
 *    并且明确告诉用户「不用这个权限也能用手工输入」；
 * 3. 「频繁弹窗反复申请」→ 已经授权时直接放行，不再弹我们自己的说明，也不再打扰系统。
 *
 * 纯逻辑放这里（可单测），真正弹 Alert 的适配层在 components/permission.ts。
 */

/**
 * 第一版只用得到这三种权限。
 *
 * 「拍照识别日程」暂缓上线，因此 App **不申请相机权限**——不申请就不该在隐私政策里声明，
 * 清单与实现必须一致（这正是上架检测会核对的东西）。
 *
 * 通知（`POST_NOTIFICATIONS`）是 2026-09-27 新加的：日程/待办的到点提醒走本地通知
 * （spec §4.5），因此必须在申请前说明用途，隐私政策 §9.2 的权限清单也要同步列出。
 */
export type PermissionKind = 'photo' | 'location' | 'notification';

export interface PermissionRationale {
  /** 说明弹窗标题 */
  title: string;
  /** 为什么要这个权限（必须具体到功能，不能写「为了更好的体验」） */
  message: string;
  /** 拒绝之后的提示：关键是说清「不影响其他功能」 */
  deniedHint: string;
}

export const PERMISSION_RATIONALE: Record<PermissionKind, PermissionRationale> = {
  photo: {
    title: '需要访问相册',
    message:
      '用于选择头像、为待办或意见反馈添加图片，以及从相册里的照片识别日程。\n\n'
      + '我们只读取您主动选中的那张图片，不会扫描、上传相册里的其他内容。\n\n'
      + '您也可以选择「不允许」，其他功能不受影响。',
    deniedHint: '未获得相册权限，其他功能不受影响；如需更换头像可稍后在系统设置里开启。',
  },
  location: {
    title: '需要使用定位',
    message:
      '用于在地图选点中定位到您当前的位置，方便把「现在这里」直接填成日程地点。\n\n'
      + '定位只在使用该功能时获取，我们不会在后台持续记录您的位置。\n\n'
      + '您也可以选择「不允许」，之后仍可搜索地点或手工输入地址。',
    deniedHint: '未获得定位权限，您可以搜索地点或手工输入地址，其他功能不受影响。',
  },
  notification: {
    title: '开启通知提醒',
    message:
      '用于在日程或待办开始前提醒您（例如「10:00 开始 · 会议室 A」）。\n\n'
      + '提醒由您的手机在本地发出，我们不通过服务端推送，也不会把日程内容交给第三方。\n\n'
      + '您也可以选择「不允许」，日程与待办照常使用，只是到点不会有提醒。',
    deniedHint: '未获得通知权限，日程与待办照常使用；如需提醒可在系统设置里打开通知，其他功能不受影响。',
  },
};

export interface PermissionGateway {
  /** 当前是否已经授权（不弹窗、不打扰） */
  current: () => Promise<boolean>;
  /** 我们自己的用途说明；返回 false 表示用户放弃申请 */
  explain: () => Promise<boolean>;
  /** 真正的系统权限弹窗 */
  request: () => Promise<boolean>;
  /** 被拒绝后的提示（不是退出） */
  reject: () => void;
}

/**
 * 拿到权限返回 true，否则返回 false。
 *
 * **永远不会**因为用户拒绝而中断 App：调用方拿到 false 后应当走「手工输入」的兜底路径。
 */
export async function ensurePermission(gateway: PermissionGateway): Promise<boolean> {
  if (await gateway.current()) {
    // 已经有权限了就别再解释一遍——那正是「频繁弹窗」的另一种形态
    return true;
  }
  if (!(await gateway.explain())) {
    return false;
  }
  if (await gateway.request()) {
    return true;
  }
  gateway.reject();
  return false;
}

export function permissionRationale(kind: PermissionKind): PermissionRationale {
  return PERMISSION_RATIONALE[kind];
}
