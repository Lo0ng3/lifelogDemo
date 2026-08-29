import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';

import AppNavigator from './src/navigation/AppNavigator';
import { LogProvider } from './src/context/LogContext';
import ErrorBoundary from './src/components/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <LogProvider>
          <BottomSheetModalProvider>
            <AppNavigator />
          </BottomSheetModalProvider>
        </LogProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}