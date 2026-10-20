import React, { useEffect, useState } from 'react';
import {
  Keyboard, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { BlurView } from 'expo-blur';

import { useTheme } from '../theme/ThemeProvider';

// 自绘底部导航：外层负责居中，内层固定 220×56。
// 不使用 React Navigation 的 tabBarStyle 做 absolute + left 百分比，
// 因为部分 Android 版本会把百分比按 0 处理，导航会卡在左边。
export default function AppTabBar({ state, descriptors, navigation, insets }) {
  const { colors, isDark } = useTheme();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(show, () => setKeyboardOpen(true));
    const hideSub = Keyboard.addListener(hide, () => setKeyboardOpen(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const route = state.routes[state.index];
  const options = descriptors[route.key]?.options || {};
  const flattenedStyle = StyleSheet.flatten(options.tabBarStyle);
  if (keyboardOpen || flattenedStyle?.display === 'none') return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: Math.max(18, (insets?.bottom || 0) - 10) }]}
    >
      <View style={[styles.bar, { borderColor: colors.border, shadowColor: colors.shadow }]}>
        {Platform.OS === 'ios' ? (
          <BlurView
            tint={isDark ? 'dark' : 'light'}
            intensity={isDark ? 50 : 60}
            style={StyleSheet.absoluteFill}
          />
        ) : (
          // Android 的 WebView 地图上持续做实时模糊非常耗合成，底栏改成轻量半透明底色。
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: isDark ? 'rgba(30,30,32,0.92)' : 'rgba(255,255,255,0.92)' },
            ]}
          />
        )}
        {state.routes.map((item, index) => {
          const focused = state.index === index;
          const itemOptions = descriptors[item.key]?.options || {};
          const color = focused ? (itemOptions.tabBarActiveTintColor || colors.accent)
            : (itemOptions.tabBarInactiveTintColor || colors.textMuted);
          const label = typeof itemOptions.tabBarLabel === 'string'
            ? itemOptions.tabBarLabel
            : item.name === 'Home' ? '印记' : '添加';
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityState={focused ? { selected: true } : {}}
              accessibilityLabel={itemOptions.tabBarAccessibilityLabel}
              onPress={() => {
                const event = navigation.emit({ type: 'tabPress', target: item.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigation.navigate(item.name);
              }}
              style={styles.item}
            >
              {itemOptions.tabBarIcon?.({ focused, color, size: 22 })}
              <Text style={[styles.label, { color }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 50,
  },
  bar: {
    width: 220,
    height: 56,
    borderRadius: 22,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 20,
    elevation: 9,
  },
  item: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
  },
});
