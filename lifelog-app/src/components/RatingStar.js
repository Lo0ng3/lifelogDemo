import React from 'react';
import { Platform, View } from 'react-native';
import { Star } from 'lucide-react-native';
import NativeIcon from './NativeIcon';

// 严格对称的整星 / 半星 / 空星组件：
// - iOS 使用系统 SF Symbols（star.fill / star.leadinghalf.filled / star），半星左右完全对称；
// - Android 采用「空星轮廓 + 精确裁切左半边实心星」叠加，避免 lucide StarHalf 右半边缺口导致不对称。
export default function RatingStar({ state = 'empty', size = 24, activeColor, emptyColor, style }) {
  if (Platform.OS === 'ios') {
    const sfName = state === 'full' ? 'star.fill' : (state === 'half' ? 'star.leadinghalf.filled' : 'star');
    const color = state === 'empty' ? emptyColor : activeColor;
    return (
      <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
        <NativeIcon name={sfName} fallback={Star} size={size} color={color} />
      </View>
    );
  }

  if (state === 'half') {
    return (
      <View style={[{ width: size, height: size }, style]}>
        <Star size={size} color={activeColor} fill="transparent" />
        <View style={{ position: 'absolute', left: 0, top: 0, width: size / 2, height: size, overflow: 'hidden' }}>
          <Star size={size} color={activeColor} fill={activeColor} />
        </View>
      </View>
    );
  }

  const isFull = state === 'full';
  return (
    <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
      <Star size={size} color={isFull ? activeColor : emptyColor} fill={isFull ? activeColor : 'transparent'} />
    </View>
  );
}
