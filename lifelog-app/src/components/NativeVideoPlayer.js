import React from 'react';
import { Platform } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let NativeVideoPlayerView = null;
if (Platform.OS === 'ios') {
  try {
    NativeVideoPlayerView = requireNativeViewManager('Thumbs', 'NativeVideoPlayerView');
  } catch {
    NativeVideoPlayerView = null;
  }
}

export const hasNativeVideoPlayer = Platform.OS === 'ios' && !!NativeVideoPlayerView;

export default function NativeVideoPlayer({
  assetId,
  uri,
  active,
  onStatusChange,
  style,
}) {
  if (!NativeVideoPlayerView) return null;
  return (
    <NativeVideoPlayerView
      assetId={assetId ? String(assetId) : null}
      uri={uri ? String(uri) : null}
      active={!!active}
      onStatusChange={(e) => onStatusChange?.(e?.nativeEvent || {})}
      style={style}
    />
  );
}
