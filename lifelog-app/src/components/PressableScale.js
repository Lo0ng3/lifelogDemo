import React, { useRef } from 'react';
import { Pressable, Animated } from 'react-native';

// 按压缩放反馈：按下轻微缩小、松手弹回，比单纯透明度更有手感
export default function PressableScale({ onPress, style, children, activeScale = 0.97 }) {
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
      onPressIn={() => animate(activeScale)}
      onPressOut={() => animate(1)}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}
