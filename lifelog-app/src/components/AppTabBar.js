import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  runOnJS, useAnimatedStyle, useSharedValue, withSpring,
} from 'react-native-reanimated';

import LiquidGlassSurface from './LiquidGlassSurface';
import NativeTabBar, { hasNativeTabBar } from './NativeTabBar';
import { useTheme } from '../theme/ThemeProvider';

const ROUTE_SF_ICONS = {
  Home: { normal: 'safari', selected: 'safari.fill' },
  Add: { normal: 'plus.circle', selected: 'plus.circle.fill' },
};

let Haptics = null;
try { Haptics = require('expo-haptics'); } catch {}

const BAR_WIDTH = 232;
const BAR_HEIGHT = 60;
const BAR_PAD = 5;
const PILL_SPRING = { damping: 22, stiffness: 280, mass: 0.72 };

// 底部悬浮液态玻璃导航栏：
// - iOS 26+：调用苹果原生 UIGlassEffect（真·液态玻璃折射与交互透镜）+ 跟手左右滑动选中玻璃胶囊；
// - iOS 15~18：系统原生 systemChromeMaterial 材质 + 高光描边 + 跟手滑动胶囊；
// - Android：轻量半透明底色（避开 WebView 地图上实时模糊掉帧）。
export default function AppTabBar({ state, descriptors, navigation, insets }) {
  const { colors, isDark } = useTheme();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // 拖拽过程中实时高亮滑到的目标页签，松手后恢复以 state.index 为准
  const [dragHoverIndex, setDragHoverIndex] = useState(null);

  const count = Math.max(1, state.routes.length);
  const pillWidth = (BAR_WIDTH - BAR_PAD * 2) / count;
  const maxPillX = Math.max(0, (count - 1) * pillWidth);

  const pillX = useSharedValue(state.index * pillWidth);
  const pillScale = useSharedValue(1);
  const activeIndex = useSharedValue(state.index);
  const isDragging = useSharedValue(false);
  const dragStartX = useSharedValue(0);
  const grabbedActive = useSharedValue(true);
  const hoverIndex = useSharedValue(state.index);
  const endedNormally = useSharedValue(false);

  useEffect(() => {
    activeIndex.value = state.index;
    setDragHoverIndex(null);
    if (!isDragging.value) {
      pillX.value = withSpring(state.index * pillWidth, PILL_SPRING);
    }
  }, [state.index, pillWidth, pillX, activeIndex, isDragging]);

  const isIOS = Platform.OS === 'ios';

  const triggerHaptic = useCallback(() => {
    if (!isIOS) return;
    try { Haptics?.selectionAsync?.(); } catch {}
  }, [isIOS]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const navRef = useRef(navigation);
  navRef.current = navigation;

  const handleHoverChange = useCallback((idx) => {
    setDragHoverIndex(idx);
    triggerHaptic();
  }, [triggerHaptic]);

  const handleClearHover = useCallback(() => {
    setDragHoverIndex(null);
  }, []);

  const commitTabIndex = useCallback((targetIndex) => {
    setDragHoverIndex(null);
    const curState = stateRef.current;
    const item = curState.routes[targetIndex];
    if (!item) return;
    const focused = curState.index === targetIndex;
    const event = navRef.current.emit({
      type: 'tabPress',
      target: item.key,
      canPreventDefault: true,
    });
    if (!focused && !event.defaultPrevented) {
      navRef.current.navigate(item.name);
    }
  }, []);

  // 左右滑动切换：模拟顶部 UISegmentedControl 的跟手拖拽手感（UI 线程 120fps）
  const panGesture = useMemo(() => (
    Gesture.Pan()
      .activeOffsetX([-5, 5])
      .onStart((e) => {
        'worklet';
        isDragging.value = true;
        endedNormally.value = false;
        const curX = activeIndex.value * pillWidth;
        const inside = e.x >= BAR_PAD + curX && e.x <= BAR_PAD + curX + pillWidth;
        grabbedActive.value = inside;
        dragStartX.value = curX;
        hoverIndex.value = activeIndex.value;
        pillScale.value = withSpring(1.045, { damping: 18, stiffness: 360, mass: 0.6 });
        if (!inside) {
          const centered = Math.max(0, Math.min(maxPillX, e.x - BAR_PAD - pillWidth / 2));
          pillX.value = centered;
          const idx = Math.max(0, Math.min(count - 1, Math.round(centered / pillWidth)));
          if (idx !== hoverIndex.value) {
            hoverIndex.value = idx;
            runOnJS(handleHoverChange)(idx);
          }
        }
      })
      .onUpdate((e) => {
        'worklet';
        const raw = grabbedActive.value
          ? dragStartX.value + e.translationX
          : e.x - BAR_PAD - pillWidth / 2;
        // 越过左右边界时做轻微橡皮筋阻尼，避免胶囊生硬撞墙
        let nextX = raw;
        if (raw < 0) nextX = Math.max(-6, raw * 0.18);
        else if (raw > maxPillX) nextX = Math.min(maxPillX + 6, maxPillX + (raw - maxPillX) * 0.18);
        pillX.value = nextX;

        const clamped = Math.max(0, Math.min(maxPillX, nextX));
        const idx = Math.max(0, Math.min(count - 1, Math.round(clamped / pillWidth)));
        if (idx !== hoverIndex.value) {
          hoverIndex.value = idx;
          runOnJS(handleHoverChange)(idx);
        }
      })
      .onEnd((e) => {
        'worklet';
        endedNormally.value = true;
        const clamped = Math.max(0, Math.min(maxPillX, pillX.value));
        let targetIdx;
        if (Math.abs(e.velocityX) > 320) {
          const dir = e.velocityX > 0 ? 1 : -1;
          targetIdx = Math.max(0, Math.min(count - 1, activeIndex.value + dir));
        } else {
          targetIdx = Math.max(0, Math.min(count - 1, Math.round(clamped / pillWidth)));
        }
        pillX.value = withSpring(targetIdx * pillWidth, { ...PILL_SPRING, velocity: e.velocityX });
        pillScale.value = withSpring(1, { damping: 20, stiffness: 320, mass: 0.7 });
        runOnJS(commitTabIndex)(targetIdx);
      })
      .onFinalize(() => {
        'worklet';
        isDragging.value = false;
        pillScale.value = withSpring(1, { damping: 20, stiffness: 320, mass: 0.7 });
        if (!endedNormally.value) {
          pillX.value = withSpring(activeIndex.value * pillWidth, PILL_SPRING);
          runOnJS(handleClearHover)();
        }
      })
  ), [
    count, pillWidth, maxPillX, pillX, pillScale, activeIndex,
    isDragging, dragStartX, grabbedActive, hoverIndex, endedNormally,
    handleHoverChange, handleClearHover, commitTabIndex,
  ]);

  const pillAnimStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: pillX.value },
      { scale: pillScale.value },
    ],
  }));

  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(show, () => setKeyboardOpen(true));
    const hideSub = Keyboard.addListener(hide, () => setKeyboardOpen(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const nativeTabMeta = useMemo(() => {
    const titles = [];
    const icons = [];
    const selectedIcons = [];
    for (const item of state.routes) {
      const itemOptions = descriptors[item.key]?.options || {};
      const label = typeof itemOptions.tabBarLabel === 'string'
        ? itemOptions.tabBarLabel
        : item.name === 'Home' ? '印记' : '添加';
      const sym = ROUTE_SF_ICONS[item.name] || { normal: 'circle', selected: 'circle.fill' };
      titles.push(label);
      icons.push(sym.normal);
      selectedIcons.push(sym.selected);
    }
    return { titles, icons, selectedIcons };
  }, [state.routes, descriptors]);

  const route = state.routes[state.index];
  const options = descriptors[route.key]?.options || {};
  const flattenedStyle = StyleSheet.flatten(options.tabBarStyle);
  if (keyboardOpen || flattenedStyle?.display === 'none') return null;

  const bottomOffset = Math.max(18, (insets?.bottom || 0) - 6);

  // iOS：与顶部视图切换使用完全相同的原生 UISegmentedControl（iOS 26 真·液态玻璃胶囊与滑块透镜）
  if (hasNativeTabBar) {
    return (
      <View pointerEvents="box-none" style={[styles.wrap, { bottom: bottomOffset }]}>
        <View
          style={[
            styles.shadowWrap,
            {
              shadowColor: colors.shadow,
              shadowOpacity: isDark ? 0.24 : 0.1,
            },
          ]}
        >
          <NativeTabBar
            titles={nativeTabMeta.titles}
            icons={nativeTabMeta.icons}
            selectedIcons={nativeTabMeta.selectedIcons}
            selectedIndex={state.index}
            isDark={isDark}
            activeColor={colors.accent}
            inactiveColor={colors.textSecondary}
            onChange={(nextIdx) => {
              if (nextIdx !== state.index) triggerHaptic();
              commitTabIndex(nextIdx);
            }}
            style={styles.nativeBar}
          />
        </View>
      </View>
    );
  }

  const displayIndex = dragHoverIndex !== null ? dragHoverIndex : state.index;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: bottomOffset }]}
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
        <GestureDetector gesture={panGesture}>
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
              const highlighted = displayIndex === index;
              const itemOptions = descriptors[item.key]?.options || {};
              const color = highlighted
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
                  {itemOptions.tabBarIcon?.({ focused: highlighted, color, size: 21 })}
                  <Text style={[styles.label, { color, fontWeight: highlighted ? '700' : '500' }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </GestureDetector>
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
  nativeBar: {
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
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
