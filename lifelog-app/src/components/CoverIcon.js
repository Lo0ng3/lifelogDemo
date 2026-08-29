import React, { useState, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { getIconConfig } from '../utils/icons';
import { resolveMediaUri, remoteImageSource, DOUBAN_POSTER_RATIO } from '../utils/media';

// 封面图标：列表/详情共用的左侧封面显示
// 固定方形槽位保证各行图片与图片、文字与文字对齐；图片按原始比例完整放入槽内（contain，不裁切）
export default function CoverIcon({ item, height = 56, style }) {
  const { IconComponent, iconColor, iconBgColor } = getIconConfig(item);
  const entry = item?.coverIndex != null ? item.localImages?.[item.coverIndex] : null;
  const [uri, setUri] = useState(null);
  useEffect(() => {
    let alive = true;
    if (entry) resolveMediaUri(entry).then(u => { if (alive) setUri(u); });
    return () => { alive = false; };
  }, [entry]);

  const src = uri || item?.coverUrl;
  if (src) {
    // 比例优先级：相册图记录的比例 → 网络封面记录的比例 → 豆瓣海报 2:3 → 方形
    const ratio = entry?.ratio
      || item?.coverRatio
      || (item?.coverUrl?.includes('doubanio.com') ? DOUBAN_POSTER_RATIO : 1);
    const width = Math.min(Math.max(height * ratio, height * 0.55), height * 2.2);
    return (
      <Image
        source={src.startsWith('http') ? remoteImageSource(src) : { uri: src }}
        style={[styles.cover, { width: height, height }, style]}
        contentFit="contain"
        transition={150}
        cachePolicy="memory"
      />
    );
  }
  return (
    <View style={[styles.iconBox, { backgroundColor: iconBgColor, width: height, height }, style]}>
      <IconComponent color={iconColor} size={Math.round(height * 0.5)} />
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { borderRadius: 8, marginRight: 12, backgroundColor: '#F3F4F6' },
  iconBox: { borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
});
