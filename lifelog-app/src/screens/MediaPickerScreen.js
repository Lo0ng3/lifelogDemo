import React, { useState, useEffect, useMemo, useContext, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Dimensions
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import { Image } from 'expo-image';
import { Check, PlayCircle } from 'lucide-react-native';
import Reanimated, { FadeIn } from 'react-native-reanimated';

import { LogContext } from '../context/LogContext';

const COLS = 4;
const CELL = Math.floor(Dimensions.get('window').width / COLS);

const formatDuration = (sec) => {
  if (!sec || sec < 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// 相册直读选图器：通过 expo-media-library 浏览相册并只记录 assetId，
// 全程不复制任何文件进 App（系统选择器会把媒体复制进缓存，无法避免）
export default function MediaPickerScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { logData } = useContext(LogContext);

  // 传入的是当前记录已挂的媒体条目（含 assetId），用于预选中与"换页加载不到也能保留"
  const ownEntries = useMemo(() => route.params?.selected || [], [route.params?.selected]);
  const ownIds = useMemo(
    () => new Set(ownEntries.map(e => e?.assetId).filter(Boolean)),
    [ownEntries]
  );
  const returnTo = route.params?.returnTo; // 'Edit'（从详情编辑进入）| 'tab'（从添加 Tab 进入）

  const [status, setStatus] = useState('checking'); // checking | granted | denied | error
  const [errorMsg, setErrorMsg] = useState('');
  const [assets, setAssets] = useState([]);
  const [endCursor, setEndCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set(ownIds));

  // 已被其它记录引用的资产：禁止重复添加（同一张照片/视频只允许挂在一个记录上）
  const usedElsewhere = useMemo(() => {
    const used = new Set();
    logData.forEach(log => (log.localImages || []).forEach(e => {
      const id = typeof e === 'string' ? null : e?.assetId;
      if (id && !ownIds.has(id)) used.add(id);
    }));
    return used;
  }, [logData, ownIds]);

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
      // 只申请照片和视频权限；默认请求会带上 AUDIO，部分环境（如 Expo Go）的
      // AndroidManifest 未声明该权限会直接抛错
      const perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
      if (perm.granted) {
        setStatus('granted');
        load();
      } else {
        setStatus('denied');
      }
    } catch (e) {
      // 权限模块异常时给出明确错误，而不是无限转圈
      const raw = String(e?.message || e);
      setErrorMsg(
        raw.includes('development build')
          ? 'Expo Go 已不支持完整的相册访问。请安装开发构建包（dev client）或正式打包后使用此功能。'
          : raw
      );
      setStatus('error');
    }
  }, [load]);

  useEffect(() => { init(); }, [init]);

  const toggle = (asset) => {
    if (usedElsewhere.has(asset.id)) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  };

  const handleConfirm = () => {
    const assetMap = new Map(assets.map(a => [a.id, a]));
    const picked = [...selected].map(id => {
      const a = assetMap.get(id);
      if (a) return {
        assetId: a.id,
        isVideo: a.mediaType === 'video',
        uri: a.uri,
        // 记录宽高比，封面按原始比例显示不裁切
        ratio: a.width && a.height ? a.width / a.height : null,
      };
      // 本记录原有的、但还没翻页加载到的条目，原样保留
      const own = ownEntries.find(e => e?.assetId === id);
      return own || { assetId: id };
    });
    if (returnTo === 'Edit') {
      navigation.navigate({ name: 'Edit', params: { picked }, merge: true });
    } else {
      navigation.navigate('Main', { screen: 'Add', params: { picked } });
    }
  };

  const renderItem = ({ item }) => {
    const isSelected = selected.has(item.id);
    const isUsed = usedElsewhere.has(item.id);
    const isVideo = item.mediaType === 'video';
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        style={[styles.cell, isSelected && styles.cellSelected]}
        onPress={() => toggle(item)}
        disabled={isUsed}
      >
        {isVideo ? (
          <View style={styles.videoBox}>
            <PlayCircle size={26} color="#FFF" />
            {!!item.duration && <Text style={styles.duration}>{formatDuration(item.duration)}</Text>}
          </View>
        ) : (
          <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" transition={80} recyclingKey={item.id} />
        )}
        {isUsed && (
          <View style={styles.usedOverlay}><Text style={styles.usedText}>已添加</Text></View>
        )}
        {isSelected && (
          <View style={styles.checkBadge}><Check size={14} color="#FFF" /></View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.navBar, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity style={styles.navBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>选择影像</Text>
        <TouchableOpacity style={styles.navBtn} onPress={handleConfirm} disabled={selected.size === 0}>
          <Text style={[styles.confirmText, selected.size === 0 && styles.confirmDisabled]}>
            {selected.size > 0 ? `完成(${selected.size})` : '完成'}
          </Text>
        </TouchableOpacity>
      </View>

      {status === 'checking' && (
        <View style={styles.deniedBox}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.deniedText}>正在读取相册…</Text>
          <Text style={styles.hintText}>如果长时间没有反应，请确认是否弹出了相册权限弹窗</Text>
        </View>
      )}
      {status === 'denied' && (
        <View style={styles.deniedBox}>
          <Text style={styles.deniedText}>需要相册权限才能选择影像</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={init}>
            <Text style={styles.retryText}>重新授权</Text>
          </TouchableOpacity>
        </View>
      )}
      {status === 'error' && (
        <View style={styles.deniedBox}>
          <Text style={styles.deniedText}>读取相册失败</Text>
          <Text style={styles.hintText}>{errorMsg}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={init}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      )}
      {status === 'granted' && (
        <Reanimated.View entering={FadeIn.duration(200)} style={{ flex: 1 }}>
          <FlatList
            data={assets}
            keyExtractor={a => a.id}
            numColumns={COLS}
            renderItem={renderItem}
            onEndReachedThreshold={0.5}
            onEndReached={() => { if (!loading && endCursor) load(endCursor); }}
            ListFooterComponent={loading ? <ActivityIndicator style={{ margin: 16 }} color="#007AFF" /> : null}
            ListEmptyComponent={!loading ? <Text style={styles.emptyText}>相册里没有照片或视频</Text> : null}
          />
        </Reanimated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF' },
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#F2F2F7', backgroundColor: '#FFF' },
  navBtn: { minWidth: 60 },
  cancelText: { fontSize: 16, color: '#6B7280' },
  navTitle: { fontSize: 17, fontWeight: '600', color: '#1C1C1E' },
  confirmText: { fontSize: 16, fontWeight: '600', color: '#007AFF', textAlign: 'right' },
  confirmDisabled: { color: '#C7C7CC' },
  cell: { width: CELL, height: CELL, padding: 1.5 },
  cellSelected: { opacity: 1 },
  thumb: { flex: 1, borderRadius: 4, backgroundColor: '#E5E5EA' },
  videoBox: { flex: 1, borderRadius: 4, backgroundColor: '#1C1C1E', alignItems: 'center', justifyContent: 'center' },
  duration: { position: 'absolute', right: 4, bottom: 4, color: '#FFF', fontSize: 10, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 2 },
  usedOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  usedText: { fontSize: 11, color: '#8E8E93' },
  checkBadge: { position: 'absolute', right: 5, top: 5, width: 22, height: 22, borderRadius: 11, backgroundColor: '#007AFF', alignItems: 'center', justifyContent: 'center' },
  deniedBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  deniedText: { fontSize: 15, color: '#6B7280', textAlign: 'center', marginBottom: 16 },
  hintText: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginBottom: 16, paddingHorizontal: 24 },
  retryBtn: { backgroundColor: '#007AFF', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 10 },
  retryText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  emptyText: { textAlign: 'center', color: '#9CA3AF', marginTop: 40 },
});
