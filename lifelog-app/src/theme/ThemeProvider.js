import React, { createContext, useContext, useMemo } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';

import { getPalette } from './palette';

const ThemeContext = createContext({
  colors: getPalette('light'),
  scheme: 'light',
  isDark: false,
});

export const ThemeProvider = ({ children }) => {
  // 只跟随系统：白天浅色、夜间深色。
  // 开屏图是原生启动资源，只能在系统层面切深浅，App 内再做手动固定就会和开屏不一致，所以不提供手动档
  const systemScheme = useColorScheme();
  const scheme = systemScheme === 'dark' ? 'dark' : 'light';
  const colors = getPalette(scheme);

  const value = useMemo(
    () => ({ colors, scheme, isDark: scheme === 'dark' }),
    [colors, scheme]
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
