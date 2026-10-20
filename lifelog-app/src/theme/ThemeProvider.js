import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getPalette } from './palette';

const ThemeContext = createContext({
  colors: getPalette('light'),
  scheme: 'light',
  isDark: false,
  mode: 'auto',
  setMode: () => {},
});

const THEME_MODE_KEY = '@ui_theme_mode';

export const ThemeProvider = ({ children }) => {
  // 默认跟随系统，也可以在「我的 → 外观」里固定浅色或深色
  const [mode, setModeState] = useState('auto');
  const systemScheme = useColorScheme();
  useEffect(() => {
    AsyncStorage.getItem(THEME_MODE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark' || stored === 'auto') setModeState(stored);
      })
      .catch(() => {});
  }, []);
  const setMode = useCallback((next) => {
    const value = next === 'light' || next === 'dark' ? next : 'auto';
    setModeState(value);
    AsyncStorage.setItem(THEME_MODE_KEY, value).catch(() => {});
  }, []);
  const scheme = mode === 'auto'
    ? (systemScheme === 'dark' ? 'dark' : 'light')
    : mode;
  const colors = getPalette(scheme);

  const value = useMemo(
    () => ({ colors, scheme, isDark: scheme === 'dark', mode, setMode }),
    [colors, scheme, mode, setMode]
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
