import React from 'react';
import { Platform } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let NativeListFilterMenuView = null;
if (Platform.OS === 'ios') {
  try {
    NativeListFilterMenuView = requireNativeViewManager('Paths', 'NativeListFilterMenuView');
  } catch {
    NativeListFilterMenuView = null;
  }
}

export const hasNativeListFilterMenu = Platform.OS === 'ios' && !!NativeListFilterMenuView;

export default function NativeListFilterMenu({
  selectedKeys = [],
  isDark = false,
  iconColor = '#5E6675',
  accentColor = '#1D63ED',
  onChange,
  style,
}) {
  if (!NativeListFilterMenuView) return null;
  return (
    <NativeListFilterMenuView
      selectedKeys={selectedKeys}
      isDark={isDark}
      iconColor={iconColor}
      accentColor={accentColor}
      onSelectionChange={(e) => {
        const keys = e?.nativeEvent?.keys;
        if (Array.isArray(keys)) onChange?.(keys);
      }}
      style={style}
    />
  );
}
