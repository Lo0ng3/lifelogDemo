import React, { useRef } from 'react';
import { Pressable, Animated } from 'react-native';

// 按压缩放反馈：按下轻微缩小、松手弹回，比单纯透明度更有手感
// containerStyle 作用在最外层 Pressable 上（要占满网格单元时用这个，而不是 style）
export default function PressableScale({ onPress, onPressIn, style, containerStyle, children, activeScale = 0.97, disabled }) {
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (toValue) => {
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 50,
      bounciness: 5,
    }).start();
  };

  return (
    <Pressable
      onPress={onPress}
      style={containerStyle}
      disabled={disabled}
      onPressIn={() => { animate(activeScale); onPressIn?.(); }}
      onPressOut={() => animate(1)}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}
