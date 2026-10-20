import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';

import { useTheme } from '../theme/ThemeProvider';

// 底部导航只做高斯模糊 + 一层很淡的 tint，不做液态玻璃高光。
export default function TabBarBlur() {
  const { colors, isDark } = useTheme();
  return (
    <View style={StyleSheet.absoluteFill}>
      <BlurView
        tint={isDark ? 'dark' : 'light'}
        intensity={isDark ? 50 : 60}
        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: isDark ? 'rgba(28,28,30,0.52)' : 'rgba(255,255,255,0.52)' },
        ]}
      />
      <View style={[styles.line, { backgroundColor: colors.border }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: StyleSheet.hairlineWidth,
  },
});
