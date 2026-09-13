import React, { useState, useEffect, useMemo, useCallback, useContext, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Dimensions, Image
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { Check, PlayCircle, ChevronDown, ChevronUp } from 'lucide-react-native';
import ImageViewing from 'react-native-image-viewing';
import Reanimated, { FadeIn } from 'react-native-reanimated';

import { LogContext } from '../context/LogContext';
import { hasGalleryAccess } from '../utils/media';

// 系统微缩略图原生模块（仅 Android 打包内置）：走系统相册同款的微缩略图管道，
// 毫秒级出图且原生侧有缓存；模块缺失（旧构建/iOS）时回退原图显示
let Thumbs = null;
try {
  Thumbs = require('../modules/thumbs').default;
} catch {}

const COLS = 3;
const CELL = Math.floor(Dimensions.get('window').width / COLS);
const THUMB_SIZE = 512;

// 常用相册白名单：相册面板默认只展示这些，其余收进「更多相册」
const COMMON_ALBUM_KEYWORDS = ['camera', '相机', 'video', '视频', 'screenshot', '截图', 'screenshots'];
const isCommonAlbum = (title) => {
  const t = String(title || '').toLowerCase();
  return COMMON_ALBUM_KEYWORDS.some(k => t.includes(k));
};
// 缓存/垃圾相册关键词：微信、QQ 等应用的缓存图片对选图没有意义，仅在"显示全部"时出现
const JUNK_ALBUM_KEYWORDS = [
  'cache', '缓存', 'thumb', 'micromsg', 'weixin', '微信', 'tencent', '腾讯',
  'qqimg', 'mobileqq', '临时', 'temp', 'nomedia',
];
const isJunkAlbum = (title) => {
  const t = String(title || '').toLowerCase();
  return JUNK_ALBUM_KEYWORDS.some(k => t.includes(k));
};

const formatDuration = (sec) => {
  if (!sec || sec < 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// 相册资产的展示地址：拼 MediaStore 标准 content:// 地址（系统相册同款读取通道），
// 交给系统 Provider 出流，规避直接解码 /storage 原始路径在部分机型 release 包上的原生崩溃
const mediaStoreUri = (asset) => {
  if (!/^\d+$/.test(asset.id || '')) return asset.uri;
  return asset.mediaType === 'video'
    ? `content://media/external/video/media/${asset.id}`
    : `content://media/external/images/media/${asset.id}`;
};

// 格子缩略图：优先走系统微缩略图（毫秒级、原生侧缓存），拿不到回退原图
function ThumbImage({ asset, style }) {
  const isVideo = asset.mediaType === 'video';
  const [uri, setUri] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!Thumbs) {
      setUri(mediaStoreUri(asset));
      return;
    }
    Thumbs.getThumbnailAsync(asset.id, isVideo, THUMB_SIZE)
      .then(r => { if (alive && r?.uri) setUri(r.uri); else if (alive) setUri(mediaStoreUri(asset)); })
      .catch(() => { if (alive) setUri(mediaStoreUri(asset)); });
    return () => { alive = false; };
  }, [asset.id, isVideo]);
  if (!uri) return <View style={[style, styles.thumbLoading]} />;
  return <Image source={{ uri }} style={style} resizeMode="cover" />;
}

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
  const [limited, setLimited] = useState(false);
  const [albums, setAlbums] = useState([]);
  const [albumId, setAlbumId] = useState(null); // null = 全部照片
  const [showAlbums, setShowAlbums] = useState(false);
  const [assets, setAssets] = useState([]);
  const [endCursor, setEndCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState(new Set(ownIds));
  // 放大预览：仅照片可进预览（微信式），预览列表与网格索引分离
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewPos, setPreviewPos] = useState(0);
  const [previewSession, setPreviewSession] = useState(0);

  // 本次会话里浏览过的资产都记下来：切换相册后，之前相册里选中的项在确认时仍能取到完整信息
  const seenAssets = useRef(new Map());

  // 相册面板：默认只给 常用（相机/视频/截图），其余收进「更多相册」，缓存仅在"显示全部"时沉底出现
  const [showMoreAlbums, setShowMoreAlbums] = useState(false);
  const [showAllAlbums, setShowAllAlbums] = useState(false);
  const { commonAlbums, otherAlbums, junkAlbums } = useMemo(() => {
    const common = [], other = [], junk = [];
    albums.forEach(a => {
      if (isJunkAlbum(a.title)) junk.push(a);
      else if (isCommonAlbum(a.title)) common.push(a);
      else other.push(a);
    });
    // 设备相册命名对不上白名单时，直接把其他相册当常用展示，避免面板空掉
    if (common.length === 0 && other.length > 0) { common.push(...other); other.length = 0; }
    return { commonAlbums: common, otherAlbums: other, junkAlbums: junk };
  }, [albums]);

  const panelRows = useMemo(() => {
    const rows = [{ id: null, kind: 'all', title: '全部照片', assetCount: albums.reduce((n, a) => n + a.assetCount, 0) }];
    commonAlbums.forEach(a => rows.push({ ...a, kind: 'common' }));
    if (otherAlbums.length > 0) {
      rows.push({ id: '__more__', kind: 'more', title: showMoreAlbums ? '其他相册' : `更多相册（${otherAlbums.length}）`, assetCount: otherAlbums.reduce((n, a) => n + a.assetCount, 0) });
      if (showMoreAlbums) otherAlbums.forEach(a => rows.push({ ...a, kind: 'other' }));
    }
    if (showAllAlbums) junkAlbums.forEach(a => rows.push({ ...a, kind: 'junk' }));
    return rows;
  }, [albums, commonAlbums, otherAlbums, junkAlbums, showMoreAlbums, showAllAlbums]);

  // 已被其它记录引用的资产：禁止重复添加（同一张照片/视频只允许挂在一个记录上）
  const usedElsewhere = useMemo(() => {
    const used = new Set();
    logData.forEach(log => (log.localImages || []).forEach(e => {
      const id = typeof e === 'string' ? null : e?.assetId;
      if (id && !ownIds.has(id)) used.add(id);
    }));
    return used;
  }, [logData, ownIds]);

  const load = useCallback(async (after, album) => {
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        first: 60,
        after,
        mediaType: ['photo', 'video'],
        sortBy: [['creationTime', false]],
        ...(album ? { album } : {}),
      });
      setAssets(prev => (after ? [...prev, ...page.assets] : page.assets));
      setEndCursor(page.hasNextPage ? page.endCursor : null);
      page.assets.forEach(a => seenAssets.current.set(a.id, a));
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
      // 只申请照片和视频权限；默认请求会带上 AUDIO，部分环境的
      // AndroidManifest 未声明该权限会直接抛错
      const perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
      if (hasGalleryAccess(perm)) {
        setLimited(perm.accessPrivileges === 'limited');
        setStatus('granted');
        load(null, null);
        // 相册列表按媒体数排序；缓存相册在展示层过滤（可用"显示全部"找回）
        MediaLibrary.getAlbumsAsync({ mediaType: ['photo', 'video'] })
          .then(list => {
            setAlbums(list
              .filter(a => a.assetCount > 0)
              .sort((a, b) => b.assetCount - a.assetCount));
          })
          .catch(() => {});
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

  const switchAlbum = (album) => {
    setShowAlbums(false);
    if ((album?.id || null) === albumId) return;
    setAlbumId(album?.id || null);
    setAssets([]);
    setEndCursor(null);
    load(null, album?.id || null);
  };

  const toggle = (asset) => {
    if (usedElsewhere.has(asset.id)) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (confirming || selected.size === 0) return;
    setConfirming(true);
    try {
      const picked = await Promise.all([...selected].map(async (id) => {
        const a = seenAssets.current.get(id);
        if (!a) {
          // 本记录原有的、但本次会话没浏览到的条目，原样保留
          const own = ownEntries.find(e => e?.assetId === id);
          return own || { assetId: id };
        }
        // 相册元数据没有文件大小，选中的少数几个逐个补上，供跨设备同步匹配用。
        // 直接 stat 相册文件路径（getAssetInfoAsync 在部分设备会因 ACCESS_MEDIA_LOCATION 缺失被拒）
        let size = null;
        try {
          const stat = await FileSystem.getInfoAsync(a.uri);
          if (stat.exists && typeof stat.size === 'number') size = stat.size;
        } catch {}
        return {
          assetId: a.id,
          uri: a.uri,
          isVideo: a.mediaType === 'video',
          // 记录宽高比，封面按原始比例显示不裁切
          ratio: a.width && a.height ? a.width / a.height : null,
          filename: a.filename || null,
          size,
          w: a.width || null,
          h: a.height || null,
        };
      }));
      if (typeof route.params?.onDone === 'function') {
        // 回调交付 + 直接返回：从哪个页面进的就退回哪个页面，调用方状态不受导航影响
        route.params.onDone(picked);
        navigation.goBack();
      } else if (returnTo === 'Edit') {
        navigation.navigate({ name: 'Edit', params: { picked }, merge: true });
      } else {
        navigation.navigate('Main', { screen: 'Add', params: { picked } });
      }
    } finally {
      setConfirming(false);
    }
  };

  // 预览列表：当前相册里的所有照片（视频不进预览），openPreview 把网格索引换算成预览索引
  const previewAssets = useMemo(() => assets.filter(a => a.mediaType !== 'video'), [assets]);
  const previewImages = useMemo(() => previewAssets.map(a => ({ uri: mediaStoreUri(a) })), [previewAssets]);
  const openPreview = (assetIndex) => {
    const asset = assets[assetIndex];
    const pos = previewAssets.findIndex(a => a.id === asset?.id);
    if (pos >= 0) {
      setPreviewPos(pos);
      setPreviewSession(s => s + 1); // 每次打开重挂载预览器，保证起始页正确
      setPreviewVisible(true);
    }
  };

  const renderItem = ({ item, index }) => {
    const isSelected = selected.has(item.id);
    const isUsed = usedElsewhere.has(item.id);
    const isVideo = item.mediaType === 'video';
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        style={[styles.cell, isSelected && styles.cellSelected]}
        onPress={() => { if (isVideo) { toggle(item); } else { openPreview(index); } }}
      >
        {isVideo ? (
          <View style={styles.videoBox}>
            <ThumbImage asset={item} style={styles.videoThumb} />
            <View style={styles.playOverlay}><PlayCircle size={26} color="#FFF" /></View>
            {!!item.duration && <Text style={styles.duration}>{formatDuration(item.duration)}</Text>}
          </View>
        ) : (
          <ThumbImage asset={item} style={styles.thumb} />
        )}
        {isUsed ? (
          <View style={styles.usedOverlay}><Text style={styles.usedText}>已添加</Text></View>
        ) : (
          <TouchableOpacity
            style={[styles.selectBadge, isSelected && styles.selectBadgeOn]}
            onPress={() => toggle(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {isSelected && <Check size={14} color="#FFF" />}
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  };

  const currentAlbum = albums.find(a => a.id === albumId);
  const albumTitle = albumId ? (currentAlbum?.title || '相册') : '全部照片';

  return (
    <View style={styles.container}>
      <View style={[styles.navBar, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity style={styles.navBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.albumBtn} onPress={() => setShowAlbums(v => !v)} disabled={status !== 'granted'}>
          <Text style={styles.navTitle} numberOfLines={1}>{albumTitle}</Text>
          {showAlbums ? <ChevronUp size={16} color="#1C1C1E" /> : <ChevronDown size={16} color="#1C1C1E" />}
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBtn} onPress={handleConfirm} disabled={selected.size === 0 || confirming}>
          <Text style={[styles.confirmText, (selected.size === 0 || confirming) && styles.confirmDisabled]}>
            {confirming ? '处理中…' : (selected.size > 0 ? `完成(${selected.size})` : '完成')}
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
        <View style={{ flex: 1 }}>
          <FlatList
            data={assets}
            keyExtractor={a => a.id}
            numColumns={COLS}
            renderItem={renderItem}
            onEndReachedThreshold={0.5}
            onEndReached={() => { if (!loading && endCursor) load(endCursor, albumId); }}
            getItemLayout={(_, index) => ({ length: CELL, offset: CELL * Math.floor(index / COLS), index })}
            ListFooterComponent={loading ? <ActivityIndicator style={{ margin: 16 }} color="#007AFF" /> : null}
            ListHeaderComponent={limited ? (
              <Text style={styles.limitedHint}>当前仅允许访问部分照片，如需完整相册请在系统设置中开放「所有照片」</Text>
            ) : null}
            ListEmptyComponent={!loading ? <Text style={styles.emptyText}>相册里没有照片或视频</Text> : null}
          />
          {showAlbums && (
            <Reanimated.View entering={FadeIn.duration(150)} style={styles.albumPanel}>
              {junkAlbums.length > 0 && (
                <View style={styles.albumFilterRow}>
                  <Text style={styles.albumFilterText}>
                    {showAllAlbums ? `已显示 ${junkAlbums.length} 个缓存相册` : `${junkAlbums.length} 个缓存相册已隐藏`}
                  </Text>
                  <TouchableOpacity onPress={() => setShowAllAlbums(v => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={styles.albumFilterBtn}>{showAllAlbums ? '收起' : '显示'}</Text>
                  </TouchableOpacity>
                </View>
              )}
              <FlatList
                data={panelRows}
                keyExtractor={(a) => String(a.id ?? a.kind ?? 'x')}
                renderItem={({ item }) => {
                  const isMore = item.kind === 'more';
                  const isJunk = item.kind === 'junk';
                  const isCurrent = !isMore && (item.id || null) === albumId;
                  return (
                    <TouchableOpacity
                      style={[styles.albumRow, isJunk && styles.albumRowJunk]}
                      onPress={() => (isMore ? setShowMoreAlbums(v => !v) : switchAlbum(item))}
                    >
                      <Text
                        style={[
                          styles.albumName,
                          isCurrent && styles.albumNameActive,
                          isJunk && styles.albumNameJunk,
                          isMore && styles.albumNameMore,
                        ]}
                        numberOfLines={1}
                      >
                        {item.title}
                      </Text>
                      <Text style={styles.albumCount}>{isMore ? (showMoreAlbums ? '▴' : '▾') : item.assetCount}</Text>
                    </TouchableOpacity>
                  );
                }}
              />
            </Reanimated.View>
          )}
        </View>
      )}

      {/* 放大预览：捏合缩放 / 双指拖动 / 左右滑换图，底部可直接勾选 */}
      <ImageViewing
        key={previewSession}
        images={previewImages}
        imageIndex={previewPos}
        visible={previewVisible}
        onRequestClose={() => setPreviewVisible(false)}
        Footer={({ imageIndex }) => {
          const a = previewAssets[imageIndex];
          if (!a) return null;
          const isSel = selected.has(a.id);
          const isUsed = usedElsewhere.has(a.id);
          return (
            <View style={styles.previewFooter}>
              <TouchableOpacity
                style={[styles.previewSelectBtn, isSel && styles.previewSelectBtnOn, isUsed && styles.previewSelectDisabled]}
                onPress={() => { if (!isUsed) toggle(a); }}
              >
                <Text style={styles.previewSelectText}>{isUsed ? '已添加' : isSel ? '已选 ✓' : '选择'}</Text>
              </TouchableOpacity>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF' },
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#F2F2F7', backgroundColor: '#FFF', zIndex: 20 },
  navBtn: { minWidth: 60 },
  albumBtn: { flexDirection: 'row', alignItems: 'center', maxWidth: 160 },
  cancelText: { fontSize: 16, color: '#6B7280' },
  navTitle: { fontSize: 17, fontWeight: '600', color: '#1C1C1E' },
  confirmText: { fontSize: 16, fontWeight: '600', color: '#007AFF', textAlign: 'right' },
  confirmDisabled: { color: '#C7C7CC' },
  cell: { width: CELL, height: CELL, padding: 1.5 },
  cellSelected: { opacity: 1 },
  thumb: { flex: 1, borderRadius: 4, backgroundColor: '#E5E5EA' },
  thumbLoading: { backgroundColor: '#E5E5EA' },
  videoThumb: { flex: 1, backgroundColor: '#26262A' },
  videoBox: { flex: 1, borderRadius: 4, backgroundColor: '#1C1C1E', overflow: 'hidden' },
  playOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  duration: { position: 'absolute', right: 4, bottom: 4, color: '#FFF', fontSize: 10, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 2 },
  liveBadge: { position: 'absolute', left: 4, top: 4, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  liveBadgeText: { color: '#FFF', fontSize: 10 },
  usedOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  usedText: { fontSize: 11, color: '#8E8E93' },
  selectBadge: { position: 'absolute', right: 5, top: 5, width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#FFF', backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center' },
  selectBadgeOn: { backgroundColor: '#007AFF', borderColor: '#007AFF' },
  previewFooter: { alignItems: 'center', paddingBottom: 24 },
  previewSelectBtn: { backgroundColor: '#007AFF', borderRadius: 20, paddingHorizontal: 28, paddingVertical: 10 },
  previewSelectBtnOn: { backgroundColor: '#34C759' },
  previewSelectDisabled: { backgroundColor: '#9CA3AF' },
  previewSelectText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  albumPanel: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.98)', zIndex: 10, paddingTop: 8 },
  albumRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F2F2F7' },
  albumName: { flex: 1, fontSize: 15, color: '#1C1C1E', marginRight: 12 },
  albumNameActive: { color: '#007AFF', fontWeight: '600' },
  albumNameMore: { color: '#007AFF' },
  albumNameJunk: { color: '#C7CAD1' },
  albumRowJunk: { opacity: 0.6 },
  albumCount: { fontSize: 13, color: '#8E8E93' },
  albumFilterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#F9FAFB' },
  albumFilterText: { fontSize: 12, color: '#9CA3AF' },
  albumFilterBtn: { fontSize: 13, color: '#007AFF', fontWeight: '600' },
  limitedHint: { fontSize: 12, color: '#B45309', backgroundColor: '#FEF3C7', margin: 8, padding: 10, borderRadius: 8, textAlign: 'center' },
  emptyText: { textAlign: 'center', color: '#9CA3AF', marginTop: 40 },
});
