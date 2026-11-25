import React from 'react';
import { Platform } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let NativeScoreMenuView = null;
if (Platform.OS === 'ios') {
  try {
    NativeScoreMenuView = requireNativeViewManager('Paths', 'NativeScoreMenuView');
  } catch {
    NativeScoreMenuView = null;
  }
}

export const hasNativeScoreMenu = Platform.OS === 'ios' && !!NativeScoreMenuView;

export default function NativeScoreMenu({ rating = 0, isDark = false, accentColor = '#1D63ED', onSelect, style }) {
  if (!NativeScoreMenuView) return null;
  return (
    <NativeScoreMenuView
      rating={Number(rating) || 0}
      isDark={isDark}
      accentColor={accentColor}
      onSelect={(e) => {
        const val = e?.nativeEvent?.rating;
        if (typeof val === 'number') onSelect?.(val);
      }}
      style={style}
    />
  );
}
