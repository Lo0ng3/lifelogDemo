import React from 'react';
import { Pressable } from 'react-native';
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';

const SPRING_IN = { damping: 24, stiffness: 460, mass: 0.45 };
const SPRING_OUT = { damping: 20, stiffness: 360, mass: 0.5 };

// 按压缩放反馈（全 UI 线程 Reanimated 驱动）：
// 取消旧版 JS Animated.spring 的桥接延迟，并把 delayPressIn 设为 0，按下瞬间响应
export default function PressableScale({
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  hitSlop,
  style,
  containerStyle,
  children,
  activeScale = 0.97,
  disabled,
  accessibilityRole,
  accessibilityLabel,
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={hitSlop}
      delayPressIn={0}
      style={containerStyle}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      onPressIn={(e) => {
        scale.value = withSpring(activeScale, SPRING_IN);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, SPRING_OUT);
        onPressOut?.(e);
      }}
    >
      <Reanimated.View style={[style, animStyle]}>
        {children}
      </Reanimated.View>
    </Pressable>
  );
}
