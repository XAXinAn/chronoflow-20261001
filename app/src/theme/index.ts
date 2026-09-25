import {
  colors,
  elevation,
  radius,
  semanticColors,
  spacing,
  typography,
  type ColorScheme,
} from '@xa-todo/design-tokens';

/**
 * App 端主题：直接消费设计令牌，不在组件里写死色值（spec §7.6.6）。
 */
export interface AppTheme {
  scheme: ColorScheme;
  color: {
    bg: string;
    surface: string;
    surfaceRaised: string;
    border: string;
    textPrimary: string;
    textSecondary: string;
    textTertiary: string;
    accent: string;
    accentContrast: string;
    success: string;
    warning: string;
    danger: string;
  };
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  shadow: string;
}

export function createTheme(scheme: ColorScheme): AppTheme {
  const palette = colors[scheme];
  const semantic = semanticColors[scheme];
  return {
    scheme,
    color: {
      bg: palette.bg,
      surface: palette.surface,
      surfaceRaised: palette.surfaceRaised,
      border: palette.border,
      textPrimary: palette.textPrimary,
      textSecondary: palette.textSecondary,
      textTertiary: palette.textTertiary,
      accent: palette.accent,
      accentContrast: palette.accentContrast,
      success: semantic.success,
      warning: semantic.warning,
      danger: semantic.danger,
    },
    spacing,
    radius,
    typography,
    shadow: elevation[scheme],
  };
}
