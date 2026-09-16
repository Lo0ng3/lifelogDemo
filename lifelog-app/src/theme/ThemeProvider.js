import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getPalette, themeModes } from './palette';

// 外观偏好：'system'（默认，跟随系统深/浅色）| 'light' | 'dark'
const STORAGE_KEY = '@theme_pref';

const ThemeContext = createContext({
  colors: getPalette('light'),
  scheme: 'light',
  isDark: false,
  preference: 'system',
  setPreference: () => {},
});

export const ThemeProvider = ({ children }) => {
  // 默认 system：夜间系统自动深色，白天浅色；用户也可以在侧边栏固定为某一档
  const [preference, setPreferenceState] = useState('system');
  const systemScheme = useColorScheme();

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => { if (alive && themeModes.includes(v)) setPreferenceState(v); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const setPreference = useCallback((next) => {
    if (!themeModes.includes(next)) return;
    setPreferenceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const scheme = preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;
  const colors = getPalette(scheme);

  const value = useMemo(
    () => ({ colors, scheme, isDark: scheme === 'dark', preference, setPreference }),
    [colors, scheme, preference, setPreference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);

// 主题化样式表：把「色板 → StyleSheet」的工厂结果按色板缓存，
// 深浅切换时重建一次，页面内其余渲染不受影响
const styleCache = new WeakMap();
export const useThemedStyles = (factory) => {
  const { colors } = useTheme();
  return useMemo(() => {
    let byPalette = styleCache.get(factory);
    if (!byPalette) {
      byPalette = new WeakMap();
      styleCache.set(factory, byPalette);
    }
    let sheet = byPalette.get(colors);
    if (!sheet) {
      sheet = StyleSheet.create(factory(colors));
      byPalette.set(colors, sheet);
    }
    return sheet;
  }, [factory, colors]);
};
