import React from 'react';
import { Platform } from 'react-native';

let SymbolView = null;
if (Platform.OS === 'ios') {
  try {
    SymbolView = require('expo-symbols').SymbolView;
  } catch {
    SymbolView = null;
  }
}

// 跨平台图标封装：
// - iOS：渲染苹果原生 SF Symbols（SymbolView），与系统字体/光学字重完全对齐；
// - Android：无缝回退到原来的 lucide-react-native 矢量图标。
export default function NativeIcon({
  name,
  fallback: Fallback,
  size = 20,
  color,
  weight = 'medium',
  style,
}) {
  if (Platform.OS === 'ios' && SymbolView && name) {
    return (
      <SymbolView
        name={name}
        size={size}
        tintColor={color}
        weight={weight}
        resizeMode="scaleAspectFit"
        style={[{ width: size, height: size }, style]}
      />
    );
  }
  if (!Fallback) return null;
  return <Fallback size={size} color={color} style={style} />;
}
