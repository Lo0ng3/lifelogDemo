import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { useTheme } from '../theme/ThemeProvider';

// Android 的 BlurView 需要显式选择实现；iOS 直接用系统材质。
const ANDROID_BLUR_METHOD = Platform.OS === 'android' ? 'dimezisBlurView' : undefined;

/* 页面背后的环境光：不是一张图片，而是两层渐变叠出来的「液态底」。
   放在每个页面根节点的第一层，滚动内容本身保持透明，玻璃卡片才有东西可透。 */
export function LiquidBackground() {
  const { colors } = useTheme();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={colors.ambientGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={colors.ambientGlowTop}
        start={{ x: 0.08, y: 0 }}
        end={{ x: 0.82, y: 0.72 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={colors.ambientGlowBottom}
        start={{ x: 0.12, y: 0.2 }}
        end={{ x: 0.94, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

/* 通用玻璃面板：
   - 需要真正模糊下层内容（导航栏、侧边栏、底栏、弹层）时 blur=true；
   - 大列表/表单本身用 blur=false，靠 tint + 高光保持性能。 */
export function GlassSurface({
  children,
  style,
  borderRadius = 20,
  blur = true,
  intensity,
  tintColor,
  flat = false,
  pointerEvents,
}) {
  const { colors, isDark } = useTheme();
  const radius = { borderRadius };

  return (
    <View
      pointerEvents={pointerEvents}
      style={[
        style,
        radius,
        { backgroundColor: 'transparent' },
        !flat && styles.shadow,
        !flat && { shadowColor: colors.glassShadow },
      ]}
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip, radius]}>
        {blur && (
          <BlurView
            tint={isDark ? 'dark' : 'light'}
            intensity={intensity ?? (isDark ? 42 : 54)}
            experimentalBlurMethod={ANDROID_BLUR_METHOD}
            style={StyleSheet.absoluteFill}
          />
        )}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: tintColor || colors.glassTint }]} />
        <LinearGradient
          colors={colors.glassSheen}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, styles.border, { borderColor: colors.glassBorder, borderRadius }]} />
      </View>
      {children}
    </View>
  );
}

/* 底部弹层的背景与页面其它玻璃保持同一套材质。 */
export function GlassSheetBackground({ style }) {
  return (
    <GlassSurface
      style={[style, styles.sheet]}
      borderRadius={24}
      intensity={Platform.OS === 'android' ? 34 : 46}
    />
  );
}

/* 底部导航的背景：让列表内容从 TabBar 底下滑过时被真正模糊。 */
export function TabBarGlass() {
  const { colors, isDark } = useTheme();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <BlurView
        tint={isDark ? 'dark' : 'light'}
        intensity={isDark ? 40 : 52}
        experimentalBlurMethod={ANDROID_BLUR_METHOD}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.tabBarTint }]} />
      <LinearGradient
        colors={colors.glassSheen}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.tabBarLine, { backgroundColor: colors.glassBorder }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.9,
    shadowRadius: 24,
    elevation: 8,
  },
  clip: {
    overflow: 'hidden',
  },
  border: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  tabBarLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: StyleSheet.hairlineWidth,
  },
});
