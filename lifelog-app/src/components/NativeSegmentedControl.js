import React from 'react';
import { Platform } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let NativeSegmentedControlView = null;
if (Platform.OS === 'ios') {
  try {
    NativeSegmentedControlView = requireNativeViewManager('Paths', 'NativeSegmentedControlView');
  } catch {
    NativeSegmentedControlView = null;
  }
}

export const hasNativeSegmentedControl = Platform.OS === 'ios' && !!NativeSegmentedControlView;

export default function NativeSegmentedControl({ segments, selectedIndex, isDark, onChange, style }) {
  if (!NativeSegmentedControlView) return null;
  return (
    <NativeSegmentedControlView
      segments={segments}
      selectedIndex={selectedIndex}
      isDark={isDark}
      onValueChange={(e) => {
        const idx = e?.nativeEvent?.index;
        if (typeof idx === 'number') onChange?.(idx);
      }}
      style={style}
    />
  );
}
