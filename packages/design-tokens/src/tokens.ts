/**
 * 时纪流（ChronoFlow）设计令牌唯一来源（spec §7.6）。
 *
 * 两端共用：Web 后台通过 CSS 变量消费，App 端通过 TS 常量消费。
 * 任何业务组件都不得硬编码色值——需要新颜色时先在这里加令牌。
 */

export type ColorScheme = 'light' | 'dark';

export interface ColorTokens {
  /** 页面底色 */
  bg: string;
  /** 卡片 / 面板 */
  surface: string;
  /** 浮层 / 弹窗 / 下拉 */
  surfaceRaised: string;
  /** 分割线与边框 */
  border: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  /** 主操作（实心按钮底色） */
  accent: string;
  /** 主操作前景色 */
  accentContrast: string;
  focusRing: string;
}

/** 全程不使用彩色主色。 */
export const colors: Record<ColorScheme, ColorTokens> = {
  light: {
    bg: '#FFFFFF',
    surface: '#FAFAFA',
    surfaceRaised: '#FFFFFF',
    border: '#E5E5E5',
    textPrimary: '#0A0A0A',
    textSecondary: '#6B6B6B',
    textTertiary: '#9E9E9E',
    accent: '#0A0A0A',
    accentContrast: '#FFFFFF',
    focusRing: 'rgba(10,10,10,.20)',
  },
  dark: {
    bg: '#0A0A0A',
    surface: '#141414',
    surfaceRaised: '#1C1C1C',
    border: '#2A2A2A',
    textPrimary: '#FAFAFA',
    textSecondary: '#A3A3A3',
    textTertiary: '#6B6B6B',
    accent: '#FFFFFF',
    accentContrast: '#0A0A0A',
    focusRing: 'rgba(255,255,255,.20)',
  },
};

/**
 * 日历格子上「休 / 班」的标记色（spec §4.1.2 / §5.11）。
 *
 * 这是全项目**唯一**允许出现彩色通道的地方，而且是刻意为之：
 * 主色系保持黑白灰（spec §7.6），但「哪几天不用上班」属于必须一眼扫出来的信息，
 * 沿用中文日历的通用约定——放假用蓝、调休上班用红。
 * 它同时满足无障碍要求：两种标记除了色相，字符本身（休 / 班）也不同，
 * 色觉障碍用户不会因为分不清颜色而看错。
 */
export interface HolidayColors {
  /** 放假 */
  holiday: string;
  /** 调休上班 */
  workday: string;
}

export const holidayColors: Record<ColorScheme, HolidayColors> = {
  light: {
    holiday: '#1565C0',
    workday: '#C62828',
  },
  dark: {
    // 深色底上统一提亮，保证对比度
    holiday: '#64B5F6',
    workday: '#EF5350',
  },
};

/** 语义色仅用于状态提示，且为降饱和版本；深色模式同色相提亮。 */
export const semanticColors: Record<
  ColorScheme,
  Record<'success' | 'warning' | 'danger', string>
> = {
  light: {
    success: '#2E7D5B',
    warning: '#B58500',
    danger: '#B3352F',
  },
  dark: {
    success: '#3EA178',
    warning: '#D19E1F',
    danger: '#D2524A',
  },
};

/**
 * 多日历场景一律使用灰度阶梯而非彩色。
 * 组织日程与个人日程的区分靠边框线型，不靠颜色（保证黑白模式下依然可辨）。
 */
export const calendarGrayscale = ['#0A0A0A', '#4A4A4A', '#8A8A8A', '#C4C4C4'] as const;

/** 8pt 栅格 */
export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const radius = {
  card: 16,
  button: 12,
  input: 12,
  tag: 8,
} as const;

export const motion = {
  easingStandard: 'cubic-bezier(.2,.8,.2,1)',
  easingSpring: 'cubic-bezier(.34,1.56,.64,1)',
  durationEnter: 240,
  durationExit: 160,
  durationSpring: 320,
  staggerStep: 30,
  durationReduced: 120,
} as const;

export const typography = {
  fontFamilySans:
    "'Inter', 'PingFang SC', 'Source Han Sans SC', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
  fontFamilyMono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  scale: {
    display: { size: 34, lineHeight: 40, weight: 600 },
    title: { size: 24, lineHeight: 32, weight: 600 },
    headline: { size: 20, lineHeight: 28, weight: 600 },
    body: { size: 16, lineHeight: 24, weight: 400 },
    caption: { size: 13, lineHeight: 18, weight: 400 },
    micro: { size: 11, lineHeight: 16, weight: 400 },
  },
} as const;

/** 阴影极轻；深色模式以描边替代阴影，避免发光感。 */
export const elevation: Record<ColorScheme, string> = {
  light: '0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06)',
  dark: 'none',
};

const STATIC_VARIABLES: Record<string, string> = {
  '--xa-space-xxs': `${spacing.xxs}px`,
  '--xa-space-xs': `${spacing.xs}px`,
  '--xa-space-sm': `${spacing.sm}px`,
  '--xa-space-md': `${spacing.md}px`,
  '--xa-space-lg': `${spacing.lg}px`,
  '--xa-space-xl': `${spacing.xl}px`,
  '--xa-space-xxl': `${spacing.xxl}px`,
  '--xa-space-xxxl': `${spacing.xxxl}px`,
  '--xa-radius-card': `${radius.card}px`,
  '--xa-radius-button': `${radius.button}px`,
  '--xa-radius-input': `${radius.input}px`,
  '--xa-radius-tag': `${radius.tag}px`,
  '--xa-easing-standard': motion.easingStandard,
  '--xa-easing-spring': motion.easingSpring,
  '--xa-duration-enter': `${motion.durationEnter}ms`,
  '--xa-duration-exit': `${motion.durationExit}ms`,
  '--xa-duration-spring': `${motion.durationSpring}ms`,
  '--xa-font-sans': typography.fontFamilySans,
  '--xa-font-mono': typography.fontFamilyMono,
};

export function staticVariables(): Record<string, string> {
  return { ...STATIC_VARIABLES };
}

/** 随配色方案变化的变量（颜色 + 语义色 + 阴影）。 */
export function schemeVariables(scheme: ColorScheme): Record<string, string> {
  const palette = colors[scheme];
  const semantic = semanticColors[scheme];
  return {
    '--xa-bg': palette.bg,
    '--xa-surface': palette.surface,
    '--xa-surface-raised': palette.surfaceRaised,
    '--xa-border': palette.border,
    '--xa-text-primary': palette.textPrimary,
    '--xa-text-secondary': palette.textSecondary,
    '--xa-text-tertiary': palette.textTertiary,
    '--xa-accent': palette.accent,
    '--xa-accent-contrast': palette.accentContrast,
    '--xa-focus-ring': palette.focusRing,
    '--xa-success': semantic.success,
    '--xa-warning': semantic.warning,
    '--xa-danger': semantic.danger,
    '--xa-holiday': holidayColors[scheme].holiday,
    '--xa-workday': holidayColors[scheme].workday,
    '--xa-shadow': elevation[scheme],
  };
}

/** 完整变量表：静态变量 + 指定方案的动态变量。 */
export function cssVariables(scheme: ColorScheme): Record<string, string> {
  return { ...staticVariables(), ...schemeVariables(scheme) };
}

export function isColorScheme(value: string): value is ColorScheme {
  return value === 'light' || value === 'dark';
}

/** 主操作按钮的前景色（浅色下白字、深色下黑字）。 */
export function primaryForeground(scheme: ColorScheme): string {
  return colors[scheme].accentContrast;
}
