import React from 'react';
import { Platform } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let NativeTabBarView = null;
if (Platform.OS === 'ios') {
  try {
    NativeTabBarView = requireNativeViewManager('Paths', 'NativeTabBarView');
  } catch {
    NativeTabBarView = null;
  }
}

export const hasNativeTabBar = Platform.OS === 'ios' && !!NativeTabBarView;

export default function NativeTabBar({
  titles,
  icons,
  selectedIcons,
  selectedIndex,
  isDark,
  activeColor,
  inactiveColor,
  onChange,
  style,
}) {
  if (!NativeTabBarView) return null;
  return (
    <NativeTabBarView
      titles={titles}
      icons={icons}
      selectedIcons={selectedIcons}
      selectedIndex={selectedIndex}
      isDark={isDark}
      activeColor={activeColor}
      inactiveColor={inactiveColor}
      onValueChange={(e) => {
        const idx = e?.nativeEvent?.index;
        if (typeof idx === 'number') onChange?.(idx);
      }}
      style={style}
    />
  );
}
