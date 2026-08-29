import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';

import AppNavigator from './src/navigation/AppNavigator';
import { LogProvider } from './src/context/LogContext';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <LogProvider>
        <BottomSheetModalProvider>
          <AppNavigator />
        </BottomSheetModalProvider>
      </LogProvider>
    </GestureHandlerRootView>
  );
}