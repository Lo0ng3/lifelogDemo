import React, { useState, useEffect, useMemo, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  Dimensions, Modal, Alert, ActivityIndicator
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import {
  Star, StarHalf, X, PlayCircle, ChevronLeft
} from 'lucide-react-native';
import { Video, ResizeMode } from 'expo-av';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { LogContext } from '../context/LogContext';
import CoverIcon from '../components/CoverIcon';
import { getIconConfig } from '../utils/icons';
import { normalizeMediaEntry, resolveMediaUri, getVideoThumbnail, isVideoEntry, remoteImageSource } from '../utils/media';
import { getLivePhotoInfo, extractMotionVideo } from '../utils/livePhoto';

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
  return <Image source={{ uri: thumb }} style={style} contentFit={contentFit} cachePolicy="memory" />;
}

// 实况徽标：异步检测动态照片（读文件头 XMP，会话内缓存），是实况才显示
function LiveGridBadge({ entry }) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    let alive = true;
    getLivePhotoInfo(entry).then(i => { if (alive) setLive(!!i?.live); });
    return () => { alive = false; };
  }, [entry]);
  if (!live) return null;
  return <View style={styles.liveBadge}><Text style={styles.liveBadgeText}>实况</Text></View>;
}

// 全屏查看器里的实况照片页：默认静帧，点按提取内嵌视频并播放（解析失败停留在静帧）
function LivePhotoPage({ entry }) {
  const [info, setInfo] = useState(null);
  const [playingUri, setPlayingUri] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setPlayingUri(null);
    getLivePhotoInfo(entry).then(i => { if (alive) setInfo(i); });
    return () => { alive = false; };
  }, [entry]);
  const isLive = !!info?.live;
  const handlePlay = async () => {
    if (loading || playingUri) return;
    setLoading(true);
    try {
      const uri = await extractMotionVideo(entry, info);
      if (uri) setPlayingUri(uri);
    } finally {
      setLoading(false);
    }
  };
  return (
    <View style={{ width: '100%', height: '80%', alignItems: 'center', justifyContent: 'center' }}>
      {playingUri ? (
        <Video
          source={{ uri: playingUri }}
          style={{ width: '100%', height: '100%' }}
          useNativeControls
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
        />
      ) : (
        <TouchableOpacity
          activeOpacity={1}
          onPress={isLive ? handlePlay : undefined}
          style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}
        >
          <Image source={{ uri: entry.uri }} style={{ width: '100%', height: '100%' }} contentFit="contain" cachePolicy="memory" />
          {isLive && (
            <View style={styles.livePlayBadge}>
              {loading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Text style={styles.livePlayText}>实况</Text>
                  <PlayCircle size={16} color="#FFF" />
                </>
              )}
            </View>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function DetailScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { logData, updateLog } = useContext(LogContext);

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

  // 封面：手动设置（coverIndex）的相册图优先，其次豆瓣海报
  const coverEntry = item?.coverIndex != null ? resolvedMedia[item.coverIndex] : null;
  const [coverUri, setCoverUri] = useState(null);
  useEffect(() => {
    let alive = true;
    if (coverEntry) resolveMediaUri(coverEntry).then(u => { if (alive) setCoverUri(u); });
    return () => { alive = false; };
  }, [coverEntry]);
  const coverSource = coverUri
    ? { uri: coverUri }
    : (item?.coverUrl ? remoteImageSource(item.coverUrl) : null);

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
        <View style={styles.navBtn} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Animated.View entering={FadeInDown.duration(300)} style={styles.detailHeader}>
          {coverSource ? (
            <CoverIcon item={item} height={46} style={{ marginRight: 0 }} />
          ) : (
            <View style={[styles.iconBox, { backgroundColor: iconConfig.iconBgColor }]}>
              {React.createElement(iconConfig.IconComponent, { color: iconConfig.iconColor, size: 28 })}
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.detailTitle}>{item.title}</Text>
            <Text style={styles.detailDate}>{item.date}</Text>
          </View>
        </Animated.View>

        {(item.rating || item.subtitle) && (
          <Animated.View entering={FadeInDown.duration(300).delay(60)} style={styles.reviewBox}>
            {!!item.rating && (
              <View style={styles.reviewRatingRow}>
                {[1, 2, 3, 4, 5].map((i) => {
                  const isFull = i <= item.rating;
                  const isHalf = i === Math.ceil(item.rating) && !Number.isInteger(item.rating);
                  if (isHalf) return <StarHalf key={i} size={22} color="#FACC15" fill="#FACC15" style={{ marginRight: 3 }} />;
                  return <Star key={i} size={22} color={isFull ? "#FACC15" : "#E5E7EB"} fill={isFull ? "#FACC15" : "transparent"} style={{ marginRight: 3 }} />;
                })}
                <Text style={styles.reviewScore}>{item.rating} 分</Text>
              </View>
            )}
            {!!item.subtitle && <Text style={styles.reviewText}>{item.subtitle}</Text>}
          </Animated.View>
        )}

        {/* 相关影像九宫格 */}
        {resolvedMedia.length > 0 && (
          <Animated.View entering={FadeInDown.duration(300).delay(120)} style={{ marginTop: 16 }}>
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
                    <>
                      <Image source={{ uri: entry.uri }} style={styles.gridImage} contentFit="cover" cachePolicy="memory" />
                      <LiveGridBadge entry={entry} />
                    </>
                  )}
                  {item.coverIndex === idx && (
                    <View style={styles.coverBadge}><Text style={styles.coverBadgeText}>封面</Text></View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </Animated.View>
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
                    // 只有滑到当前页才真正挂载播放器，划走立即卸载，避免多个视频同时解码；
                    // 播放器底下垫一层封面帧，首帧解码完成前不会黑屏闪烁
                    <View style={{ width: '100%', height: '80%' }}>
                      <VideoThumb entry={entry} style={StyleSheet.absoluteFill} contentFit="contain" />
                      <Video
                        source={{ uri: entry.uri }}
                        style={{ width: '100%', height: '100%' }}
                        useNativeControls
                        resizeMode={ResizeMode.CONTAIN}
                        shouldPlay
                        onError={(e) => console.warn('[video] 播放失败', entry.uri, e)}
                      />
                    </View>
                  ) : (
                    <View style={{ width: '100%', height: '80%', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
                      <VideoThumb entry={entry} style={{ width: '100%', height: '100%' }} contentFit="contain" />
                    </View>
                  )
                ) : (
                  <LivePhotoPage entry={entry} />
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
  detailTitle: { fontSize: 19, fontWeight: '700', color: '#1C1C1E' },
  detailDate: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  ratingText: { marginLeft: 8, fontSize: 13, color: '#6B7280' },
  reviewBox: { backgroundColor: '#FFF', borderRadius: 12, padding: 16, marginTop: 12 },
  reviewRatingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  reviewScore: { marginLeft: 10, fontSize: 16, fontWeight: '700', color: '#FACC15' },
  reviewText: { fontSize: 16, color: '#374151', lineHeight: 24 },
  coverBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  coverBadgeText: { color: '#FFF', fontSize: 10 },
  liveBadge: { position: 'absolute', left: 8, top: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  liveBadgeText: { color: '#FFF', fontSize: 10 },
  livePlayBadge: { position: 'absolute', right: 16, bottom: 16, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  livePlayText: { color: '#FFF', fontSize: 12, marginRight: 5 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#1C1C1E' },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginTop: 8 },
  gridItem: { width: '33.33%', padding: 4 },
  gridImage: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: '#E5E5EA' },
  videoThumbnailBox: { width: '100%', aspectRatio: 1, borderRadius: 10, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: '#E5E5EA' },
  playOverlay: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  viewerContainer: { flex: 1, backgroundColor: '#000' },
  viewerCloseBtn: { position: 'absolute', zIndex: 10, right: 16 },
});
