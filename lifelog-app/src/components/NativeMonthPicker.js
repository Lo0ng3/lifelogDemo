import React from 'react';
import { Platform } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let NativeMonthPickerView = null;
if (Platform.OS === 'ios') {
  try {
    NativeMonthPickerView = requireNativeViewManager('Paths', 'NativeMonthPickerView');
  } catch {
    NativeMonthPickerView = null;
  }
}

export const hasNativeMonthPicker = Platform.OS === 'ios' && !!NativeMonthPickerView;

export default function NativeMonthPicker({
  minYear = 2000,
  maxYear = 2035,
  year,
  month,
  isDark = false,
  onChange,
  style,
}) {
  if (!NativeMonthPickerView) return null;
  return (
    <NativeMonthPickerView
      minYear={minYear}
      maxYear={maxYear}
      year={year}
      month={month}
      isDark={isDark}
      onChange={(e) => {
        const y = e?.nativeEvent?.year;
        const m = e?.nativeEvent?.month;
        if (typeof y === 'number' && typeof m === 'number') {
          onChange?.({ year: y, month: m });
        }
      }}
      style={style}
    />
  );
}
