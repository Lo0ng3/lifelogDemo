import React from 'react';
import { Platform } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let NativeLivePhotoView = null;
if (Platform.OS === 'ios') {
  try {
    NativeLivePhotoView = requireNativeViewManager('Thumbs', 'NativeLivePhotoView');
  } catch {
    NativeLivePhotoView = null;
  }
}

export const hasNativeLivePhoto = Platform.OS === 'ios' && !!NativeLivePhotoView;

export default function NativeLivePhoto({
  assetId,
  active,
  playTrigger,
  onPlaybackChange,
  onLoadState,
  style,
}) {
  if (!NativeLivePhotoView) return null;
  return (
    <NativeLivePhotoView
      assetId={String(assetId || '')}
      active={!!active}
      playTrigger={playTrigger || 0}
      onPlaybackChange={(e) => onPlaybackChange?.(!!e?.nativeEvent?.playing)}
      onLoadState={(e) => onLoadState?.(e?.nativeEvent || {})}
      style={style}
    />
  );
}
