import React, { useState, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { getIconConfig } from '../utils/icons';
import { resolveMediaUri, remoteImageSource } from '../utils/media';

// 封面展示：固定方形槽位（透明、无底色），封面按原比例完整显示并居中（contain），
// 不裁切不拉伸不强制铺满，槽位内空隙即卡片背景。
// 槽位尺寸由调用方决定（列表 64 / 详情 80），文字起点因此对所有条目统一。
// 无封面时回退类型图标（现状一致）。
export default function CoverIcon({ item, height = 64, style }) {
  const { IconComponent, iconColor, iconBgColor } = getIconConfig(item);
  const entry = item?.coverIndex != null ? item.localImages?.[item.coverIndex] : null;
  const [uri, setUri] = useState(null);
  useEffect(() => {
    let alive = true;
    if (entry) resolveMediaUri(entry).then(u => { if (alive) setUri(u); });
    return () => { alive = false; };
  }, [entry]);

  const src = uri || item?.coverUrl;
  return (
    <View style={[styles.slot, { width: height, height }, style]}>
      {src ? (
        <Image
          source={src.startsWith('http') ? remoteImageSource(src) : { uri: src }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
          cachePolicy="memory"
        />
      ) : (
        <View style={[styles.iconBox, { backgroundColor: iconBgColor }]}>
          <IconComponent color={iconColor} size={Math.round(height * 0.5)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { alignItems: 'center', justifyContent: 'center', marginRight: 12, borderRadius: 8 },
  iconBox: { width: '100%', height: '100%', borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
