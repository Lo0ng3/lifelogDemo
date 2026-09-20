import React, { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { ShareIntentProvider } from 'expo-share-intent';

import AppNavigator from './src/navigation/AppNavigator';
import { LogProvider } from './src/context/LogContext';
import ErrorBoundary from './src/components/ErrorBoundary';
import ShareIntentBridge from './src/components/ShareIntentBridge';
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
      {/* 系统分享进来的影像 → 跳到「添加」页挂到表单上（自身不渲染 UI） */}
      <ShareIntentBridge />
    </View>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      {/* 分享意图的 Provider 要在最外层：图库分享过来时它是第一个要拿到数据的地方 */}
      <ShareIntentProvider>
        <ThemeProvider>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <LogProvider>
              <BottomSheetModalProvider>
                <Shell />
              </BottomSheetModalProvider>
            </LogProvider>
          </GestureHandlerRootView>
        </ThemeProvider>
      </ShareIntentProvider>
    </ErrorBoundary>
  );
}
