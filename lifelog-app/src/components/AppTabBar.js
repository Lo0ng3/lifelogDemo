import React, { useEffect, useState } from 'react';
import {
  Keyboard, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import LiquidGlassSurface from './LiquidGlassSurface';
import { useTheme } from '../theme/ThemeProvider';

let Haptics = null;
try { Haptics = require('expo-haptics'); } catch {}

const BAR_WIDTH = 232;
const BAR_HEIGHT = 60;
const BAR_PAD = 5;

// 底部悬浮液态玻璃导航栏：
// - iOS 26+：调用苹果原生 UIGlassEffect（真·液态玻璃折射与交互透镜）+ 滑动选中玻璃胶囊；
// - iOS 15~18：系统原生 systemChromeMaterial 材质 + 高光描边 + 滑动胶囊；
// - Android：轻量半透明底色（避开 WebView 地图上实时模糊掉帧）。
export default function AppTabBar({ state, descriptors, navigation, insets }) {
  const { colors, isDark } = useTheme();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const count = Math.max(1, state.routes.length);
  const pillWidth = (BAR_WIDTH - BAR_PAD * 2) / count;
  const pillX = useSharedValue(state.index * pillWidth);

  useEffect(() => {
    pillX.value = withSpring(state.index * pillWidth, {
      damping: 22,
      stiffness: 280,
      mass: 0.72,
    });
  }, [state.index, pillWidth, pillX]);

  const pillAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.value }],
  }));

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

  const isIOS = Platform.OS === 'ios';

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: Math.max(18, (insets?.bottom || 0) - 6) }]}
    >
      {/* 外层负责阴影（不设 overflow:hidden，否则 iOS 会裁掉阴影） */}
      <View
        style={[
          styles.shadowWrap,
          {
            shadowColor: colors.shadow,
            shadowOpacity: isIOS ? (isDark ? 0.22 : 0.08) : (isDark ? 0.42 : 0.16),
          },
        ]}
      >
        <View
          style={[
            styles.bar,
            !isIOS && { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
          ]}
        >
          <LiquidGlassSurface cornerRadius={BAR_HEIGHT / 2} isDark={isDark} interactive />

          {/* 选中项轻透玻璃胶囊：iOS 不盖乳白底，保持苹果原生液态玻璃的清透质感 */}
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.activePill,
              {
                width: pillWidth,
                backgroundColor: isDark
                  ? 'rgba(255,255,255,0.14)'
                  : (isIOS ? 'rgba(11,13,18,0.065)' : 'rgba(29,99,237,0.10)'),
                borderColor: 'transparent',
              },
              pillAnimStyle,
            ]}
          />

          {state.routes.map((item, index) => {
            const focused = state.index === index;
            const itemOptions = descriptors[item.key]?.options || {};
            const color = focused
              ? (itemOptions.tabBarActiveTintColor || colors.accent)
              : (itemOptions.tabBarInactiveTintColor || colors.textSecondary);
            const label = typeof itemOptions.tabBarLabel === 'string'
              ? itemOptions.tabBarLabel
              : item.name === 'Home' ? '印记' : '添加';
            return (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityState={focused ? { selected: true } : {}}
                accessibilityLabel={itemOptions.tabBarAccessibilityLabel}
                delayPressIn={0}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                onPress={() => {
                  if (isIOS && !focused) {
                    try { Haptics?.selectionAsync?.(); } catch {}
                  }
                  const event = navigation.emit({ type: 'tabPress', target: item.key, canPreventDefault: true });
                  if (!focused && !event.defaultPrevented) navigation.navigate(item.name);
                }}
                style={({ pressed }) => [styles.item, pressed && !focused && { opacity: 0.65 }]}
              >
                {itemOptions.tabBarIcon?.({ focused, color, size: 21 })}
                <Text style={[styles.label, { color, fontWeight: focused ? '700' : '500' }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
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
  shadowWrap: {
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 22,
    elevation: 9,
  },
  bar: {
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    padding: BAR_PAD,
    flexDirection: 'row',
    alignItems: 'center',
  },
  activePill: {
    position: 'absolute',
    left: BAR_PAD,
    top: BAR_PAD,
    bottom: BAR_PAD,
    borderRadius: (BAR_HEIGHT - BAR_PAD * 2) / 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  item: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    zIndex: 1,
  },
  label: {
    fontSize: 10.5,
  },
});
