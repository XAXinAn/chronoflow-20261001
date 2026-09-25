import { colors, motion, primaryForeground, radius, semanticColors, typography, type ColorScheme } from './tokens.js';

/**
 * 映射到 Ant Design 5 的主题令牌。
 *
 * 刻意不依赖 antd 类型：令牌包保持零运行时依赖，
 * Web 后台把返回值直接交给 `ConfigProvider theme={{ token }}`。
 */
export interface AntdThemeToken {
  colorPrimary: string;
  colorBgBase: string;
  colorBgContainer: string;
  colorBgElevated: string;
  colorBgLayout: string;
  colorText: string;
  colorTextSecondary: string;
  colorTextTertiary: string;
  colorTextQuaternary: string;
  colorBorder: string;
  colorBorderSecondary: string;
  colorSplit: string;
  colorSuccess: string;
  colorWarning: string;
  colorError: string;
  colorLink: string;
  borderRadius: number;
  borderRadiusLG: number;
  borderRadiusSM: number;
  fontFamily: string;
  fontFamilyCode: string;
  motionDurationMid: string;
  motionDurationSlow: string;
  motionEaseInOut: string;
  controlHeight: number;
  wireframe: boolean;
}

export function antdThemeToken(scheme: ColorScheme): AntdThemeToken {
  const palette = colors[scheme];
  const semantic = semanticColors[scheme];

  return {
    // 主色刻意等于「强调色」，因此在浅色下是黑底白字、深色下是白底黑字
    colorPrimary: palette.accent,
    colorBgBase: palette.bg,
    colorBgContainer: palette.surfaceRaised,
    colorBgElevated: palette.surfaceRaised,
    colorBgLayout: palette.bg,
    colorText: palette.textPrimary,
    colorTextSecondary: palette.textSecondary,
    colorTextTertiary: palette.textTertiary,
    colorTextQuaternary: palette.textTertiary,
    colorBorder: palette.border,
    colorBorderSecondary: palette.border,
    colorSplit: palette.border,
    colorSuccess: semantic.success,
    colorWarning: semantic.warning,
    colorError: semantic.danger,
    colorLink: palette.textPrimary,
    borderRadius: radius.button,
    borderRadiusLG: radius.card,
    borderRadiusSM: radius.tag,
    fontFamily: typography.fontFamilySans,
    fontFamilyCode: typography.fontFamilyMono,
    motionDurationMid: `${motion.durationEnter}ms`,
    motionDurationSlow: `${motion.durationSpring}ms`,
    motionEaseInOut: motion.easingStandard,
    controlHeight: 36,
    wireframe: false,
  };
}

export { primaryForeground };
