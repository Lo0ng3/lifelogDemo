import React, { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';

import AppNavigator from './src/navigation/AppNavigator';
import { LogProvider } from './src/context/LogContext';
import ErrorBoundary from './src/components/ErrorBoundary';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';

// 外观外壳：跟随系统深/浅色（可在侧边栏固定），并把根视图与状态栏一起切换，
// 这样页面切换露出底层时不会闪白
function Shell() {
  const { colors, isDark } = useTheme();

  useEffect(() => {
    if (Platform.OS === 'web') return;
    SystemUI.setBackgroundColorAsync(colors.bg).catch(() => {});
  }, [colors.bg]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <AppNavigator />
    </View>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <LogProvider>
            <BottomSheetModalProvider>
              <Shell />
            </BottomSheetModalProvider>
          </LogProvider>
        </GestureHandlerRootView>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
