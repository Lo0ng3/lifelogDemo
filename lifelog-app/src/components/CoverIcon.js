import React, { useState, useEffect } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { getIconConfig } from '../utils/icons';
import { resolveMediaUri, remoteImageSource } from '../utils/media';
import { useTheme } from '../theme/ThemeProvider';

// 封面展示：固定方形槽位（透明、无底色），封面按原比例完整显示并居中（contain），
// 不裁切不拉伸不强制铺满，槽位内空隙即卡片背景。
// 槽位尺寸由调用方决定（列表 64 / 详情 80），文字起点因此对所有条目统一。
// 无封面时回退类型图标（现状一致）。
export default function CoverIcon({ item, height = 64, style }) {
  const { colors } = useTheme();
  const { IconComponent, iconColor, iconBgColor } = getIconConfig(item, colors);
  const entry = item?.coverIndex != null ? item.localImages?.[item.coverIndex] : null;
  const [uri, setUri] = useState(() => (Platform.OS === 'ios' && entry?.assetId ? `ph://${entry.assetId}` : null));
  // 自选封面的小图文件（coverThumbUrl）直接显示，省去每次重启解析相册；
  // 没有小图、或小图文件已经不在了（换机导入、被清理、旧版本没写成功）就实时解析
  // assetId——否则封面会一直空着，看起来像"封面被去掉了"
  useEffect(() => {
    let alive = true;
    const thumb = item?.coverThumbUrl;
    const fromAlbum = () => {
      if (Platform.OS === 'ios' && entry?.assetId) {
        if (alive) setUri(`ph://${entry.assetId}`);
        return;
      }
      resolveMediaUri(entry).then(u => { if (alive) setUri(u); });
    };
    if (!entry) { setUri(null); return () => { alive = false; }; }
    if (!thumb) { fromAlbum(); return () => { alive = false; }; }
    FileSystem.getInfoAsync(thumb)
      .then(info => { if (!info.exists) fromAlbum(); })
      .catch(() => fromAlbum());
    return () => { alive = false; };
  }, [entry, item?.coverThumbUrl]);

  const src = item?.coverThumbUrl || uri || item?.coverUrl;
  return (
    <View style={[styles.slot, { width: height, height }, style]}>
      {src ? (
        <Image
          source={src.startsWith('http') ? remoteImageSource(src) : { uri: src }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
          // memory 只走内存缓存：列表来回滑、封面被挤出内存就得重新联网下载，
          // 滚动时就是一团解码/GC 抖动。memory-disk 是默认档，落盘一次之后不再重下
          cachePolicy="memory-disk"
          // 列表回收格子时告诉 expo-image「这是换了内容的新图」，避免闪上一行的封面
          recyclingKey={item?.id != null ? String(item.id) : undefined}
        />
      ) : (
        <View style={[styles.iconBox, { backgroundColor: iconBgColor }]}>
          <IconComponent color={iconColor} size={Math.round(height * 0.44)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { alignItems: 'center', justifyContent: 'center', marginRight: 12, borderRadius: 11, overflow: 'hidden' },
  iconBox: { width: '100%', height: '100%', borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
