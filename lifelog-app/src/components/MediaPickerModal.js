import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Modal, Dimensions
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { Image } from 'expo-image';
import { Check, PlayCircle, X } from 'lucide-react-native';

const COLS = 4;
const GAP = 2;
const CELL = Math.floor((Dimensions.get('window').width - GAP * (COLS - 1)) / COLS);
const BG = '#111111';

const formatDuration = (sec) => {
  if (!sec || sec < 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// 相册直读选图器（全屏 Modal，不经过导航，调用方表单状态不受影响）
// - 轻点单选/取消，长按进入滑动连选（手指划过的格子依次选中，松手结束）
// - 只记录 assetId，全程零复制；usedAssetIds 中的资产标记"已添加"不可再选
export default function MediaPickerModal({ visible, onClose, onConfirm, selectedEntries = [], usedAssetIds = [] }) {
  const ownIds = useMemo(() => new Set(selectedEntries.map(e => e?.assetId).filter(Boolean)), [selectedEntries]);
  const usedSet = useMemo(() => new Set(usedAssetIds), [usedAssetIds]);

  const [status, setStatus] = useState('checking'); // checking | granted | denied | error
  const [errorMsg, setErrorMsg] = useState('');
  const [assets, setAssets] = useState([]);
  const [endCursor, setEndCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [dragMode, setDragMode] = useState(false);

  const rects = useRef(new Map());      // assetId -> 相对网格内容的 {x, y, w, h}
  const gridPage = useRef({ x: 0, y: 0 });
  const scrollOffset = useRef(0);
  const gridRef = useRef(null);

  const load = useCallback(async (after) => {
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        first: 60,
        after,
        mediaType: ['photo', 'video'],
        sortBy: [['creationTime', false]],
      });
      setAssets(prev => (after ? [...prev, ...page.assets] : page.assets));
      setEndCursor(page.hasNextPage ? page.endCursor : null);
    } catch (e) {
      console.error('读取相册失败', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const init = useCallback(async () => {
    setStatus('checking');
    setErrorMsg('');
    try {
      // 只申请照片和视频权限；默认请求会带上 AUDIO，部分环境的 AndroidManifest 未声明会直接抛错
      const perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
      if (perm.granted) {
        setStatus('granted');
        load();
      } else {
        setStatus('denied');
      }
    } catch (e) {
      const raw = String(e?.message || e);
      setErrorMsg(
        raw.includes('development build')
          ? 'Expo Go 已不支持完整的相册访问。请安装开发构建包（dev client）或正式打包后使用此功能。'
          : raw
      );
      setStatus('error');
    }
  }, [load]);

  useEffect(() => {
    if (visible) {
      setSelected(new Set(ownIds));
      setDragMode(false);
      init();
    }
  }, [visible]);

  const selectAdd = (id) => {
    if (usedSet.has(id)) return;
    setSelected(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  const toggle = (id) => {
    if (usedSet.has(id)) return;
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  // 长按：选中该格并进入滑动连选模式（此时网格不可滚动，滑动全部转为选择）
  const enterDragMode = (id) => {
    if (usedSet.has(id)) return;
    selectAdd(id);
    setDragMode(true);
  };

  // 滑动连选：把屏幕坐标换算成网格内容坐标，命中哪个格子就选中哪个
  const selectAt = (pageX, pageY) => {
    const x = pageX - gridPage.current.x;
    const y = pageY - gridPage.current.y + scrollOffset.current;
    for (const [id, r] of rects.current.entries()) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        selectAdd(id);
        return;
      }
    }
  };

  const handleConfirm = () => {
    const assetMap = new Map(assets.map(a => [a.id, a]));
    const ownMap = new Map(selectedEntries.map(e => [e?.assetId, e]).filter(([id]) => id));
    const picked = [...selected]
      .map(id => {
        const a = assetMap.get(id);
        if (a) return { assetId: a.id, isVideo: a.mediaType === 'video', uri: a.uri, ratio: a.width && a.height ? a.width / a.height : null };
        const own = ownMap.get(id);
        return own || null;
      })
      .filter(Boolean);
    onConfirm(picked);
  };

  const renderItem = ({ item }) => {
    const isSelected = selected.has(item.id);
    const isUsed = usedSet.has(item.id);
    const isVideo = item.mediaType === 'video';
    return (
      <View
        style={[styles.cellWrap, { width: CELL, height: CELL }]}
        onLayout={(e) => {
          const { x, y, width, height } = e.nativeEvent.layout;
          rects.current.set(item.id, { x, y, w: width, h: height });
        }}
      >
        <TouchableOpacity
          activeOpacity={0.75}
          style={styles.cellInner}
          disabled={isUsed}
          onPress={() => toggle(item.id)}
          onLongPress={() => enterDragMode(item.id)}
          delayLongPress={250}
        >
          {isVideo ? (
            <View style={styles.videoBox}>
              <PlayCircle size={26} color="#FFF" />
              {!!item.duration && <Text style={styles.duration}>{formatDuration(item.duration)}</Text>}
            </View>
          ) : (
            <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" transition={80} recyclingKey={item.id} cachePolicy="memory" />
          )}
          {isUsed && (
            <View style={styles.usedOverlay}><Text style={styles.usedText}>已添加</Text></View>
          )}
          {isSelected && (
            <View style={styles.checkBadge}><Check size={14} color="#FFF" /></View>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.container}>
        {/* 顶部栏 */}
        <View style={styles.navBar}>
          <TouchableOpacity style={styles.navBtn} onPress={onClose}>
            <X size={24} color="#FFF" />
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={styles.navTitle}>选择影像</Text>
            <Text style={styles.navHint}>轻点单选 · 长按拖动连选</Text>
          </View>
          <TouchableOpacity
            style={[styles.confirmBtn, selected.size === 0 && styles.confirmBtnDisabled]}
            disabled={selected.size === 0}
            onPress={handleConfirm}
          >
            <Text style={styles.confirmText}>完成{selected.size > 0 ? ` ${selected.size}` : ''}</Text>
          </TouchableOpacity>
        </View>

        {status === 'checking' && (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.centerText}>正在读取相册…</Text>
            <Text style={styles.hintText}>如果长时间没有反应，请确认是否弹出了相册权限弹窗</Text>
          </View>
        )}
        {status === 'denied' && (
          <View style={styles.centerBox}>
            <Text style={styles.centerText}>需要相册权限才能选择影像</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={init}>
              <Text style={styles.retryText}>重新授权</Text>
            </TouchableOpacity>
          </View>
        )}
        {status === 'error' && (
          <View style={styles.centerBox}>
            <Text style={styles.centerText}>读取相册失败</Text>
            <Text style={styles.hintText}>{errorMsg}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={init}>
              <Text style={styles.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        )}
        {status === 'granted' && (
          <View
            style={{ flex: 1 }}
            onLayout={() => {
              // 记录网格在窗口中的位置，滑动连选时用于换算触点坐标
              gridRef.current?.measureInWindow((x, y) => { gridPage.current = { x, y }; });
            }}
          >
            <FlatList
              ref={gridRef}
              data={assets}
              keyExtractor={a => a.id}
              numColumns={COLS}
              renderItem={renderItem}
              scrollEnabled={!dragMode}
              onScroll={(e) => { scrollOffset.current = e.nativeEvent.contentOffset.y; }}
              scrollEventThrottle={16}
              onEndReachedThreshold={0.5}
              onEndReached={() => { if (!loading && endCursor) load(endCursor); }}
              contentContainerStyle={{ paddingBottom: GAP }}
              columnWrapperStyle={{ gap: GAP }}
              ListFooterComponent={loading ? <ActivityIndicator style={{ margin: 16 }} color="#007AFF" /> : null}
              ListEmptyComponent={!loading ? <Text style={styles.emptyText}>相册里没有照片或视频</Text> : null}
              // 滑动连选：网格在捕获阶段接管手指移动，划过的格子依次选中
              onMoveShouldSetResponderCapture={() => dragMode}
              onResponderMove={(e) => selectAt(e.nativeEvent.pageX, e.nativeEvent.pageY)}
              onResponderRelease={() => setDragMode(false)}
              onResponderTerminate={() => setDragMode(false)}
            />
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  navBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#2C2C2E',
  },
  navBtn: { width: 44, alignItems: 'flex-start' },
  navTitle: { fontSize: 17, fontWeight: '600', color: '#FFF' },
  navHint: { fontSize: 10, color: '#8E8E93', marginTop: 1 },
  confirmBtn: { backgroundColor: '#007AFF', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 7 },
  confirmBtnDisabled: { backgroundColor: '#2C2C2E' },
  confirmText: { color: '#FFF', fontSize: 14, fontWeight: '600' },
  cellWrap: { padding: GAP / 2 },
  cellInner: { flex: 1, borderRadius: 4, overflow: 'hidden', backgroundColor: '#1C1C1E' },
  thumb: { flex: 1, backgroundColor: '#1C1C1E' },
  videoBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  duration: { position: 'absolute', right: 4, bottom: 4, color: '#FFF', fontSize: 10, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 2 },
  usedOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  usedText: { fontSize: 11, color: '#8E8E93' },
  checkBadge: { position: 'absolute', right: 5, top: 5, width: 22, height: 22, borderRadius: 11, backgroundColor: '#007AFF', alignItems: 'center', justifyContent: 'center' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  centerText: { fontSize: 15, color: '#E5E5EA', textAlign: 'center', marginBottom: 16 },
  hintText: { fontSize: 12, color: '#8E8E93', textAlign: 'center', marginBottom: 16, paddingHorizontal: 24 },
  retryBtn: { backgroundColor: '#007AFF', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 10 },
  retryText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  emptyText: { textAlign: 'center', color: '#8E8E93', marginTop: 40 },
});
