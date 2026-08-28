import React, { useState, useEffect, useMemo, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  Dimensions, Modal, Alert
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import {
  Star, StarHalf, X, Edit3, Trash2, PlayCircle, ChevronLeft
} from 'lucide-react-native';
import { Video, ResizeMode } from 'expo-av';

import { LogContext } from '../context/LogContext';
import { getIconConfig } from '../utils/icons';
import { normalizeMediaEntry, resolveMediaUri, getVideoThumbnail, isVideoEntry } from '../utils/media';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// 视频封面：只生成一次封面帧（内存缓存），避免为了一张缩略图挂载真实播放器
function VideoThumb({ entry, style, contentFit = 'cover' }) {
  const [thumb, setThumb] = useState(null);
  useEffect(() => {
    let alive = true;
    getVideoThumbnail(entry).then(t => { if (alive && t) setThumb(t); });
    return () => { alive = false; };
  }, [entry]);
  if (!thumb) return null;
  return <Image source={{ uri: thumb }} style={style} contentFit={contentFit} />;
}

export default function DetailScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { logData, deleteLog, updateLog } = useContext(LogContext);

  // 通过 id 从全局数据里取，编辑/删除后页面能自动同步
  const itemId = route.params?.item?.id;
  const item = useMemo(
    () => logData.find(l => l.id === itemId),
    [logData, itemId]
  );

  const [viewerIndex, setViewerIndex] = useState(-1);
  const [currentViewIndex, setCurrentViewIndex] = useState(-1);
  const onViewableItemsChanged = useMemo(
    () => ({ viewableItems }) => {
      if (viewableItems.length > 0) setCurrentViewIndex(viewableItems[0].index);
    },
    []
  );
  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 50 }), []);

  // 详情里的媒体：先用备用 URI 占位，再异步把 assetId 解析成相册里的原始文件路径
  const [resolvedMedia, setResolvedMedia] = useState([]);
  useEffect(() => {
    let alive = true;
    const entries = item?.localImages || [];
    setResolvedMedia(entries.map(normalizeMediaEntry));
    Promise.all(
      entries.map(async (entry) => ({ ...normalizeMediaEntry(entry), uri: await resolveMediaUri(entry) }))
    ).then((resolved) => { if (alive) setResolvedMedia(resolved); });
    return () => { alive = false; };
  }, [item]);

  const handleEdit = () => {
    // Add 是 Tab 里的页面，必须通过外层 Stack 的 Main 路由嵌套导航，直接 navigate('Add') 会被丢弃
    navigation.navigate('Main', { screen: 'Add', params: { editItem: item } });
  };

  // 封面：长按九宫格里任意一张设为/取消封面，记录在 coverIndex 上
  const handleGridLongPress = (idx) => {
    const isCurrentCover = item.coverIndex === idx;
    Alert.alert('封面设置', '将这张影像设为该记录的封面吗？', [
      { text: '取消', style: 'cancel' },
      ...(item.coverIndex != null
        ? [{ text: '取消封面', style: 'destructive', onPress: () => updateLog({ ...item, coverIndex: null }) }]
        : []),
      { text: isCurrentCover ? '重新设为封面' : '设为封面', onPress: () => updateLog({ ...item, coverIndex: idx }) },
    ]);
  };

  const handleDelete = () => {
    Alert.alert('删除印记', '你确定要永远抹去这条印记吗？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { deleteLog(item.id); navigation.goBack(); } }
    ]);
  };

  if (!item) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 20 }]}>
        <StatusBar style="dark" />
        <Text style={styles.emptyText}>这条印记已不存在</Text>
      </View>
    );
  }

  const iconConfig = getIconConfig(item);

  return (
    <View style={styles.container}>
      <StatusBar style={viewerIndex >= 0 ? 'light' : 'dark'} />

      {/* 顶部导航栏 */}
      <View style={[styles.navBar, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity style={styles.navBtn} onPress={() => navigation.goBack()}>
          <ChevronLeft size={24} color="#1C1C1E" />
        </TouchableOpacity>
        <Text style={styles.navTitle} numberOfLines={1}>{item.title}</Text>
        <View style={styles.navBtn}>
          <TouchableOpacity onPress={handleEdit}><Edit3 size={20} color="#007AFF" /></TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={styles.detailHeader}>
          <View style={[styles.iconBox, { backgroundColor: iconConfig.iconBgColor }]}>
            {React.createElement(iconConfig.IconComponent, { color: iconConfig.iconColor, size: 28 })}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.detailTitle}>{item.title}</Text>
            <Text style={styles.detailDate}>{item.date}</Text>
          </View>
          <TouchableOpacity onPress={handleDelete}>
            <Trash2 size={20} color="#EF4444" />
          </TouchableOpacity>
        </View>

        {item.rating && (
          <View style={styles.ratingRow}>
            {[1, 2, 3, 4, 5].map((i) => {
              const isFull = i <= item.rating;
              const isHalf = i === Math.ceil(item.rating) && !Number.isInteger(item.rating);
              if (isHalf) return <StarHalf key={i} size={16} color="#FACC15" fill="#FACC15" style={{ marginRight: 2 }} />;
              return <Star key={i} size={16} color={isFull ? "#FACC15" : "#E5E7EB"} fill={isFull ? "#FACC15" : "transparent"} style={{ marginRight: 2 }} />;
            })}
            <Text style={styles.ratingText}>{item.rating} 分</Text>
          </View>
        )}

        {!!item.subtitle && (
          <View style={styles.descBox}>
            <Text style={styles.descText}>{item.subtitle}</Text>
          </View>
        )}

        {/* 相关影像九宫格 */}
        {resolvedMedia.length > 0 && (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.sectionTitle}>相关影像（长按可设为封面）</Text>
            <View style={styles.imageGrid}>
              {resolvedMedia.map((entry, idx) => (
                <TouchableOpacity
                  key={idx}
                  activeOpacity={0.8}
                  onPress={() => { setViewerIndex(idx); setCurrentViewIndex(idx); }}
                  onLongPress={() => handleGridLongPress(idx)}
                  style={styles.gridItem}
                >
                  {isVideoEntry(entry) ? (
                    <View style={styles.videoThumbnailBox}>
                      <VideoThumb entry={entry} style={styles.gridImage} />
                      <View style={styles.playOverlay}><PlayCircle size={30} color="#FFF" /></View>
                    </View>
                  ) : (
                    <Image source={{ uri: entry.uri }} style={styles.gridImage} contentFit="cover" />
                  )}
                  {item.coverIndex === idx && (
                    <View style={styles.coverBadge}><Text style={styles.coverBadgeText}>封面</Text></View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {/* 全屏图片/视频查看器 */}
      <Modal visible={viewerIndex >= 0} transparent animationType="fade" statusBarTranslucent={true} onRequestClose={() => { setViewerIndex(-1); setCurrentViewIndex(-1); }}>
        <View style={styles.viewerContainer}>
          <TouchableOpacity style={[styles.viewerCloseBtn, { top: insets.top + 10 }]} onPress={() => { setViewerIndex(-1); setCurrentViewIndex(-1); }}>
            <X size={28} color="#FFF" />
          </TouchableOpacity>

          <FlatList
            data={resolvedMedia}
            keyExtractor={(_, i) => i.toString()}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={viewerIndex >= 0 ? viewerIndex : 0}
            getItemLayout={(_, index) => ({ length: SCREEN_WIDTH, offset: SCREEN_WIDTH * index, index })}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            renderItem={({ item: entry, index }) => (
              <View style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT, justifyContent: 'center' }}>
                {isVideoEntry(entry) ? (
                  index === currentViewIndex ? (
                    // 只有滑到当前页才真正挂载播放器，划走立即卸载，避免多个视频同时解码
                    <Video
                      source={{ uri: entry.uri }}
                      style={{ width: '100%', height: '80%' }}
                      useNativeControls
                      resizeMode={ResizeMode.CONTAIN}
                      shouldPlay
                    />
                  ) : (
                    <View style={{ width: '100%', height: '80%', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
                      <VideoThumb entry={entry} style={{ width: '100%', height: '100%' }} contentFit="contain" />
                    </View>
                  )
                ) : (
                  <Image source={{ uri: entry.uri }} style={{ width: '100%', height: '80%' }} contentFit="contain" />
                )}
              </View>
            )}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  emptyText: { textAlign: 'center', color: '#9CA3AF', fontSize: 15 },
  navBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#F2F2F7', paddingHorizontal: 12, paddingBottom: 8
  },
  navBtn: { width: 36, alignItems: 'center' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: '#1C1C1E', marginHorizontal: 4 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 14, padding: 14, gap: 12 },
  iconBox: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  detailTitle: { fontSize: 18, fontWeight: '700', color: '#1C1C1E' },
  detailDate: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  ratingText: { marginLeft: 8, fontSize: 13, color: '#6B7280' },
  descBox: { backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginTop: 12 },
  descText: { fontSize: 14, color: '#374151', lineHeight: 21 },
  coverBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  coverBadgeText: { color: '#FFF', fontSize: 10 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#1C1C1E' },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginTop: 8 },
  gridItem: { width: '33.33%', padding: 4 },
  gridImage: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: '#E5E5EA' },
  videoThumbnailBox: { width: '100%', aspectRatio: 1, borderRadius: 10, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: '#E5E5EA' },
  playOverlay: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  viewerContainer: { flex: 1, backgroundColor: '#000' },
  viewerCloseBtn: { position: 'absolute', zIndex: 10, right: 16 },
});
