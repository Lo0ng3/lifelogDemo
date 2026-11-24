import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import { BlurView } from 'expo-blur';

let NativeLiquidGlassView = null;
if (Platform.OS === 'ios') {
  try {
    NativeLiquidGlassView = requireNativeViewManager('Paths');
  } catch {
    NativeLiquidGlassView = null;
  }
}

// 跨平台液态玻璃背景层：
// - iOS：优先使用原生 LiquidGlassView（iOS 26+ 真·UIGlassEffect，iOS 15~18 原生 systemChromeMaterial）；
// - Android：轻量半透明底色（避开 WebView 上实时模糊的合成掉帧）。
export default function LiquidGlassSurface({ cornerRadius = 28, isDark = false, interactive = true, style }) {
  if (Platform.OS === 'ios') {
    if (NativeLiquidGlassView) {
      return (
        <NativeLiquidGlassView
          pointerEvents="none"
          cornerRadius={cornerRadius}
          isDark={isDark}
          interactive={interactive}
          style={[StyleSheet.absoluteFill, style]}
        />
      );
    }
    return (
      <BlurView
        pointerEvents="none"
        tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        intensity={isDark ? 65 : 75}
        style={[StyleSheet.absoluteFill, style]}
      />
    );
  }
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: isDark ? 'rgba(30,30,32,0.92)' : 'rgba(255,255,255,0.92)' },
        style,
      ]}
    />
  );
}
