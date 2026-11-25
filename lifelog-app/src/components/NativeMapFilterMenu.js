import React from 'react';
import { Platform } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let NativeMapFilterMenuView = null;
if (Platform.OS === 'ios') {
  try {
    NativeMapFilterMenuView = requireNativeViewManager('Paths', 'NativeMapFilterMenuView');
  } catch {
    NativeMapFilterMenuView = null;
  }
}

export const hasNativeMapFilterMenu = Platform.OS === 'ios' && !!NativeMapFilterMenuView;

export default function NativeMapFilterMenu({
  selectedKeys = [],
  isDark = false,
  iconColor = '#5E6675',
  accentColor = '#1D63ED',
  onToggle,
  style,
}) {
  if (!NativeMapFilterMenuView) return null;
  return (
    <NativeMapFilterMenuView
      selectedKeys={selectedKeys}
      isDark={isDark}
      iconColor={iconColor}
      accentColor={accentColor}
      onToggle={(e) => {
        const key = e?.nativeEvent?.key;
        if (typeof key === 'string' && key) onToggle?.(key);
      }}
      style={style}
    />
  );
}
