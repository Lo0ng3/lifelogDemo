import React, { useState, useEffect, useMemo, useCallback, useContext, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Dimensions, Platform
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import { Check, PlayCircle, ChevronDown, ChevronUp } from 'lucide-react-native';
import ImageViewing from 'react-native-image-viewing';
import Reanimated, {
  FadeIn, useSharedValue, useAnimatedStyle, useAnimatedRef, useAnimatedScrollHandler,
  scrollTo, runOnJS, withTiming, withDelay, cancelAnimation,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { LogContext } from '../context/LogContext';
import { hasGalleryAccess } from '../utils/media';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';

// 系统微缩略图原生模块（仅 Android 打包内置）：走系统相册同款的微缩略图管道，
// 毫秒级出图且原生侧有缓存；模块缺失（旧构建/iOS）时回退原图显示
let Thumbs = null;
try {
  Thumbs = require('../modules/thumbs').default;
} catch {}

const COLS = 3;
const CELL = Math.floor(Dimensions.get('window').width / COLS);
// 格子只有 130dp 上下，缩略图取 256px 已经够锐；原来一律要 512px，
// 解码/传输量是现在的 4 倍，属于白花的开销
const THUMB_PX = 256;
const THUMB_CACHE_MAX = 1200;
const THUMB_H = 44;          // 快速定位条滑块高度
const FAST_TRACK_ROWS = 2;   // 超过约两屏才出现快速定位条

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

// 日期分组的显示文案（快速定位气泡用）
const monthLabelOf = (creationTime) => {
  if (!creationTime) return '';
  const d = new Date(creationTime);
  return d.getFullYear() === new Date().getFullYear()
    ? `${d.getMonth() + 1}月`
    : `${d.getFullYear()}年${d.getMonth() + 1}月`;
};

/* ------------------------------------------------------------------ *
 * 缩略图仓库
 *
 * 滑动卡顿的大头不是「取图慢」，而是「每滑一屏都发起一大堆重复请求 + 每次
 * 请求回来都 setState」。这里做三件事：
 *   1. 内存 LRU 缓存：格子挂载时同步就能拿到 uri，不留白、不闪烁；
 *   2. 同 id 请求去重：格子被回收再挂载不会重复打桥；
 *   3. 空闲预取：按可视区顺序预热后续一批，滑动时几乎总是命中缓存。
 * ------------------------------------------------------------------ */
const thumbCache = new Map();     // assetId -> uri
const thumbInflight = new Map();  // assetId -> Promise

function rememberThumb(id, uri) {
  if (thumbCache.has(id)) thumbCache.delete(id);
  thumbCache.set(id, uri);
  if (thumbCache.size > THUMB_CACHE_MAX) {
    const drop = thumbCache.size - THUMB_CACHE_MAX;
    let i = 0;
    for (const k of thumbCache.keys()) {
      if (i++ >= drop) break;
      thumbCache.delete(k);
    }
  }
}

function loadThumb(asset) {
  const id = asset.id;
  const cached = thumbCache.get(id);
  if (cached) return Promise.resolve(cached);
  const inFlight = thumbInflight.get(id);
  if (inFlight) return inFlight;
  const task = (async () => {
    if (Thumbs) {
      try {
        const r = await Thumbs.getThumbnailAsync(id, asset.mediaType === 'video', THUMB_PX);
        if (r?.uri) {
          rememberThumb(id, r.uri);
          return r.uri;
        }
      } catch {}
    }
    // 拿不到系统微缩略图（旧系统 / iOS 未打包模块）：回退原图，交给 expo-image 缓存
    const fallback = mediaStoreUri(asset);
    rememberThumb(id, fallback);
    return fallback;
  })().finally(() => { thumbInflight.delete(id); });
  thumbInflight.set(id, task);
  return task;
}

// 预取代次：换相册/重新加载时旧任务自动作废，避免后台白发请求
let prefetchToken = 0;
function prefetchThumbs(list, from, count = 30) {
  if (!Thumbs || !list.length) return;
  const token = ++prefetchToken;
  const start = Math.max(0, from);
  const end = Math.min(list.length, start + count);
  let i = start;
  const step = () => {
    if (token !== prefetchToken || i >= end) return;
    const asset = list[i++];
    if (!asset) return;
    // 每张之间让出一次事件循环，预取不跟可见区抢桥
    loadThumb(asset).catch(() => {}).then(() => setTimeout(step, 0));
  };
  step();
}

function useThumbUri(asset) {
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const id = asset?.id;
  const isVideo = asset?.mediaType === 'video';
  const [uri, setUri] = useState(() => (id ? thumbCache.get(id) : null) || null);
  useEffect(() => {
    if (!id) return undefined;
    const cached = thumbCache.get(id);
    if (cached) {
      setUri(cached);
      return undefined;
    }
    let alive = true;
    setUri(null);  // 复用格子换了资产：先清空，避免串图
    loadThumb(assetRef.current).then(u => { if (alive) setUri(u); }).catch(() => {});
    return () => { alive = false; };
  }, [id, isVideo]);
  return uri;
}

/* ------------------------------------------------------------------ *
 * 网格格子
 *
 * memo + 精确比较：选中某一张时只重绘那一格，其余格子（含正在播的角标、
 * 缩略图）完全不动；这是原来「点一下整屏都重绘」的主要修复点。
 * ------------------------------------------------------------------ */
const Cell = React.memo(function Cell({ asset, index, selected, used, isVideo, onOpen, onToggle }) {
  const styles = useThemedStyles(makeStyles);
  const uri = useThumbUri(asset);
  const showThumb = uri ? (
    <Image
      source={{ uri }}
      style={isVideo ? styles.videoThumb : styles.thumb}
      contentFit="cover"
      cachePolicy="memory-disk"
      recyclingKey={asset.id}
      transition={0}
    />
  ) : (
    <View style={isVideo ? styles.videoThumb : [styles.thumb, styles.thumbLoading]} />
  );

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      style={styles.cell}
      onPress={() => (isVideo ? onToggle(asset) : onOpen(index))}
    >
      {isVideo ? (
        <View style={styles.videoBox}>
          {showThumb}
          <View style={styles.playOverlay}><PlayCircle size={26} color="#FFF" /></View>
          {!!asset.duration && <Text style={styles.duration}>{formatDuration(asset.duration)}</Text>}
        </View>
      ) : showThumb}
      {used ? (
        <View style={styles.usedOverlay}><Text style={styles.usedText}>已添加</Text></View>
      ) : (
        <TouchableOpacity
          style={[styles.selectBadge, selected && styles.selectBadgeOn]}
          onPress={() => onToggle(asset)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {selected && <Check size={14} color="#FFF" />}
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}, (a, b) => (
  a.asset.id === b.asset.id &&
  a.index === b.index &&
  a.selected === b.selected &&
  a.used === b.used &&
  a.isVideo === b.isVideo
));

/* ------------------------------------------------------------------ *
 * 相册直读选图器：通过 expo-media-library 浏览相册并只记录 assetId，
 * 全程不复制任何文件进 App（系统选择器会把媒体复制进缓存，无法避免）
 * ------------------------------------------------------------------ */
export default function MediaPickerScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
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
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState(new Set(ownIds));
  // 放大预览：仅照片可进预览（微信式），预览列表与网格索引分离
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewPos, setPreviewPos] = useState(0);
  const [previewSession, setPreviewSession] = useState(0);

  // 本次会话里浏览过的资产都记下来：切换相册后，之前相册里选中的项在确认时仍能取到完整信息
  const seenAssets = useRef(new Map());

  // 分页加载防抖：onEndReached 可能在同一帧内触发多次，loading state 还没来得及更新会重复追加
  const loadingRef = useRef(false);
  const loadGen = useRef(0);   // 加载代次：切换相册时作废仍在途的旧结果
  const assetsRef = useRef([]);
  assetsRef.current = assets;
  const albumIdRef = useRef(null);
  albumIdRef.current = albumId;
  const endCursorRef = useRef(null);
  endCursorRef.current = endCursor;

  /* -------- 滚动：全部动画量走 UI 线程，滚动过程中不再 setState -------- */
  const listRef = useAnimatedRef();
  const scrollY = useSharedValue(0);
  const contentH = useSharedValue(0);
  const viewH = useSharedValue(0);
  const thumbFrac = useSharedValue(0);
  const barOpacity = useSharedValue(0);
  const dragging = useSharedValue(false);
  const seekTick = useSharedValue(0);
  const lastMonthKey = useSharedValue('');
  const monthKeys = useSharedValue([]);   // 每个资产对应的月份文案，快速定位气泡用
  const [gridHeight, setGridHeight] = useState(0);
  const [hasLongContent, setHasLongContent] = useState(false);
  // 滑块只在「刚滚动过 / 正在拖动」时露脸，此时才接管右边缘的手势；
  // 平时那一条是透明且不响应手势的，避免误触把列表弹到别处
  const [barActive, setBarActive] = useState(false);
  const [bubbleText, setBubbleText] = useState('');
  const barHideTimer = useRef(null);

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
    const rows = [{ id: null, kind: 'all', title: '全部照片', assetCount: totalCount || assets.length }];
    commonAlbums.forEach(a => rows.push({ ...a, kind: 'common' }));
    if (otherAlbums.length > 0) {
      rows.push({ id: '__more__', kind: 'more', title: showMoreAlbums ? '其他相册' : `更多相册（${otherAlbums.length}）`, assetCount: otherAlbums.reduce((n, a) => n + a.assetCount, 0) });
      if (showMoreAlbums) otherAlbums.forEach(a => rows.push({ ...a, kind: 'other' }));
    }
    if (showAllAlbums) junkAlbums.forEach(a => rows.push({ ...a, kind: 'junk' }));
    return rows;
  }, [assets.length, commonAlbums, otherAlbums, junkAlbums, showMoreAlbums, showAllAlbums, totalCount]);

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
    if (after && loadingRef.current) return;   // 分页防抖；换相册等"全新加载"不受限，但会作废旧结果
    const gen = ++loadGen.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        first: 90,                              // 一页 30 行：分页次数少一半，触发加载的频率也跟着降
        after,
        mediaType: ['photo', 'video'],
        sortBy: [['creationTime', false]],
        ...(album ? { album } : {}),
      });
      if (gen !== loadGen.current) return;     // 期间发生了新的加载，丢弃过期结果
      setAssets(prev => (after ? [...prev, ...page.assets] : page.assets));
      setEndCursor(page.hasNextPage ? page.endCursor : null);
      if (typeof page.totalCount === 'number') setTotalCount(page.totalCount);
      page.assets.forEach(a => seenAssets.current.set(a.id, a));
    } catch (e) {
      console.error('读取相册失败', e);
    } finally {
      if (gen === loadGen.current) {
        loadingRef.current = false;
        setLoading(false);
      }
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

  // 资产变化后同步给 UI 线程：内容总高度 + 每月文案表（快速定位气泡）
  useEffect(() => {
    contentH.value = Math.ceil(assets.length / COLS) * CELL + 44;  // 44 = 固定的底部占位
    monthKeys.value = assets.map(a => monthLabelOf(a.creationTime));
    // 预取可视区往后一批：滑动时大多数格子直接命中内存缓存
    prefetchThumbs(assets, Math.floor(scrollY.value / CELL) * COLS, 30);
  }, [assets, contentH, monthKeys, scrollY]);

  // 内容超过约两屏才需要快速定位条
  useEffect(() => {
    const rows = Math.ceil(assets.length / COLS);
    setHasLongContent(rows > FAST_TRACK_ROWS + Math.max(0, Math.ceil(gridHeight / CELL)));
  }, [assets.length, gridHeight]);

  const switchAlbum = (album) => {
    setShowAlbums(false);
    if ((album?.id || null) === albumId) return;
    prefetchToken++;                                // 作废上一相册的预取队列
    setAlbumId(album?.id || null);
    setAssets([]);
    setEndCursor(null);
    setTotalCount(0);
    scrollY.value = 0;
    scrollTo(listRef, 0, 0, false);
    load(null, album?.id || null);
  };

  const toggle = useCallback((asset) => {
    setSelected(prev => {
      if (usedElsewhere.has(asset.id)) return prev;
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  }, [usedElsewhere]);

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

  /* ------------------------- 快速定位（滑块 / 气泡） ------------------------- */

  // 拖动/滚动到某个比例：定位到对应位置，并顺带把目标区域的下一页拉过来
  const emitSeek = useCallback((frac) => {
    const list = assetsRef.current;
    const total = Math.ceil(Math.max(list.length, 1) / COLS) * CELL;
    const targetRow = Math.floor(frac * Math.max(0, Math.ceil(total / CELL) - Math.ceil(gridHeight / CELL)));
    const loadedRows = Math.ceil(list.length / COLS);
    // 目标还没加载到：按住不放会连续补页，直到覆盖目标位置
    if (endCursorRef.current && targetRow > Math.max(0, loadedRows - Math.ceil(gridHeight / CELL) - 1)) {
      if (!loadingRef.current) load(endCursorRef.current, albumIdRef.current);
    }
  }, [gridHeight, load]);

  const emitBubble = useCallback((text) => { setBubbleText(text); }, []);

  const showBarFor = useCallback((ms = 700) => {
    setBarActive(true);
    clearTimeout(barHideTimer.current);
    barHideTimer.current = setTimeout(() => setBarActive(false), ms);
  }, []);

  useEffect(() => () => clearTimeout(barHideTimer.current), []);

  // 滚动位置的落点：顶部第一张图的月份（只在月份变化时才回 JS 线程一次）
  const updateBubbleAt = (offsetY) => {
    'worklet';
    const idx = Math.floor(Math.max(0, offsetY) / CELL) * COLS;
    const key = monthKeys.value[idx];
    if (key && key !== lastMonthKey.value) {
      lastMonthKey.value = key;
      runOnJS(emitBubble)(key);
    }
  };

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      const y = e.contentOffset.y;
      scrollY.value = y;
      const max = Math.max(1, contentH.value - viewH.value);
      thumbFrac.value = Math.min(1, Math.max(0, y / max));
      if (!dragging.value) updateBubbleAt(y);
    },
    onBeginDrag: () => {
      cancelAnimation(barOpacity);
      barOpacity.value = withTiming(1, { duration: 120 });
      runOnJS(showBarFor)(900);
    },
    onEndDrag: () => {
      const text = lastMonthKey.value;
      if (text) runOnJS(emitBubble)(text);
      barOpacity.value = withDelay(700, withTiming(0, { duration: 250 }));
      runOnJS(showBarFor)(900);
    },
    onMomentumBegin: () => { cancelAnimation(barOpacity); barOpacity.value = 1; runOnJS(showBarFor)(900); },
    onMomentumEnd: () => {
      barOpacity.value = withDelay(700, withTiming(0, { duration: 250 }));
      runOnJS(showBarFor)(900);
      // 停下后补一批预取，下一次滑动依然是热缓存
      runOnJS(prefetchThumbs)(assetsRef.current, Math.floor(scrollY.value / CELL) * COLS, 30);
    },
  });

  // 拖滑块：在 UI 线程里直接改 scrollTo，不经过 setState，所以拖动是跟手的
  const seekToY = (y) => {
    'worklet';
    const travel = Math.max(1, viewH.value - THUMB_H - 20);
    const frac = Math.min(1, Math.max(0, (y - THUMB_H / 2) / travel));
    thumbFrac.value = frac;
    scrollTo(listRef, 0, frac * Math.max(0, contentH.value - viewH.value), false);
    updateBubbleAt(frac * Math.max(0, contentH.value - viewH.value));
    seekTick.value = (seekTick.value + 1) % 4;
    if (seekTick.value === 0) runOnJS(emitSeek)(frac);
  };

  const panGesture = Gesture.Pan()
    .enabled(hasLongContent && barActive)
    .onBegin((e) => {
      dragging.value = true;
      cancelAnimation(barOpacity);
      barOpacity.value = 1;
      // 拖动期间保持接管状态（手势中途被 disable 会被系统取消）
      runOnJS(showBarFor)(30000);
      seekToY(e.y);
    })
    .onUpdate((e) => { seekToY(e.y); })
    .onFinalize(() => {
      dragging.value = false;
      barOpacity.value = withDelay(600, withTiming(0, { duration: 250 }));
      runOnJS(showBarFor)(700);
    });

  const trackStyle = useAnimatedStyle(() => ({ opacity: barOpacity.value }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: thumbFrac.value * Math.max(0, viewH.value - 20 - THUMB_H) }],
  }));
  const bubbleStyle = useAnimatedStyle(() => ({
    opacity: barOpacity.value,
    transform: [{ translateY: thumbFrac.value * Math.max(0, viewH.value - 20 - THUMB_H) + (THUMB_H - 30) / 2 }],
  }));

  /* ------------------------------- 网格 ------------------------------- */

  const openPreview = useCallback((assetIndex) => {
    const asset = assetsRef.current[assetIndex];
    if (!asset || asset.mediaType === 'video') return;
    // 预览列表：当前相册里的照片（视频不进预览），把网格索引换算成预览索引
    const pos = assetsRef.current.slice(0, assetIndex).filter(a => a.mediaType !== 'video').length;
    setPreviewPos(pos);
    setPreviewSession(s => s + 1); // 每次打开重挂载预览器，保证起始页正确
    setPreviewVisible(true);
  }, []);

  const renderItem = useCallback(({ item, index }) => (
    <Cell
      asset={item}
      index={index}
      selected={selected.has(item.id)}
      used={usedElsewhere.has(item.id)}
      isVideo={item.mediaType === 'video'}
      onOpen={openPreview}
      onToggle={toggle}
    />
  ), [openPreview, selected, toggle, usedElsewhere]);

  const onEndReached = useCallback(() => {
    if (!loadingRef.current && endCursorRef.current) load(endCursorRef.current, albumIdRef.current);
  }, [load]);

  const onGridLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    viewH.value = h;
    setGridHeight(h);
  }, [viewH]);

  const previewAssets = useMemo(() => assets.filter(a => a.mediaType !== 'video'), [assets]);
  const previewImages = useMemo(() => previewAssets.map(a => ({ uri: mediaStoreUri(a) })), [previewAssets]);
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
          {showAlbums
            ? <ChevronUp size={16} color={colors.text} />
            : <ChevronDown size={16} color={colors.text} />}
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBtn} onPress={handleConfirm} disabled={selected.size === 0 || confirming}>
          <Text style={[styles.confirmText, (selected.size === 0 || confirming) && styles.confirmDisabled]}>
            {confirming ? '处理中…' : (selected.size > 0 ? `完成(${selected.size})` : '完成')}
          </Text>
        </TouchableOpacity>
      </View>

      {status === 'checking' && (
        <View style={styles.deniedBox}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.deniedText}>正在读取相册…</Text>
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
        <View style={styles.gridWrap}>
          {limited && <Text style={styles.limitedHint}>仅可访问部分照片</Text>}
          <View style={{ flex: 1 }} onLayout={onGridLayout}>
            <Reanimated.FlatList
              ref={listRef}
              data={assets}
              keyExtractor={keyExtractor}
              numColumns={COLS}
              renderItem={renderItem}
              onScroll={scrollHandler}
              scrollEventThrottle={16}
              onEndReached={onEndReached}
              onEndReachedThreshold={1.5}
              // numColumns>1 时 FlatList 传给 getItemLayout 的 index 是行号（每行=CELL 高）
              getItemLayout={(_, index) => ({ length: CELL, offset: CELL * index, index })}
              // 虚拟化：3 列网格每屏 9 格，窗口给 ±2 屏就够，超出的一律不挂载
              initialNumToRender={COLS * 4}
              maxToRenderPerBatch={COLS * 3}
              windowSize={5}
              updateCellsBatchingPeriod={30}
              removeClippedSubviews={Platform.OS === 'android'}
              ListFooterComponent={loading
                ? <ActivityIndicator style={styles.footer} color={colors.accent} />
                : <View style={styles.footer} />}
              ListEmptyComponent={!loading ? <Text style={styles.emptyText}>相册里没有照片或视频</Text> : null}
            />
          </View>

          {/* 快速定位：平时完全透明不挡手，滚动/拖动时淡入 */}
          {hasLongContent && (
            <>
              <GestureDetector gesture={panGesture}>
                <Reanimated.View style={[styles.fastTrack, trackStyle]} />
              </GestureDetector>
              <Reanimated.View style={[styles.fastThumb, thumbStyle]} pointerEvents="none" />
              <Reanimated.View style={[styles.fastBubble, bubbleStyle]} pointerEvents="none">
                <Text style={styles.fastBubbleText}>{bubbleText}</Text>
              </Reanimated.View>
            </>
          )}

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

const keyExtractor = (a) => a.id;

const makeStyles = (c) => ({
  container: { flex: 1, backgroundColor: c.bgElevated },
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.divider, backgroundColor: c.bgElevated, zIndex: 20 },
  navBtn: { minWidth: 60 },
  albumBtn: { flexDirection: 'row', alignItems: 'center', maxWidth: 160 },
  cancelText: { fontSize: 16, color: c.textSecondary },
  navTitle: { fontSize: 17, fontWeight: '600', color: c.text },
  confirmText: { fontSize: 16, fontWeight: '600', color: c.accent, textAlign: 'right' },
  confirmDisabled: { color: c.textFaint },

  gridWrap: { flex: 1, backgroundColor: c.bgElevated },
  cell: { width: CELL, height: CELL, padding: 1.5 },
  thumb: { flex: 1, borderRadius: 4, backgroundColor: c.mediaPlaceholder },
  thumbLoading: { backgroundColor: c.mediaPlaceholder },
  videoThumb: { flex: 1, backgroundColor: c.mediaPlaceholder },
  videoBox: { flex: 1, borderRadius: 4, backgroundColor: c.fill, overflow: 'hidden' },
  playOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  duration: { position: 'absolute', right: 4, bottom: 4, color: '#FFF', fontSize: 10, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 2 },
  usedOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: c.scheme === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  usedText: { fontSize: 11, color: c.textSecondary },
  selectBadge: { position: 'absolute', right: 5, top: 5, width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#FFF', backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center' },
  selectBadgeOn: { backgroundColor: c.accent, borderColor: c.accent },

  // 快速定位：滑块 = 中空胶囊；轨道平时透明（不挡手），滚动/拖动时由动画控制淡入
  fastTrack: { position: 'absolute', right: 0, top: 10, bottom: 10, width: 36, zIndex: 5 },
  fastThumb: { position: 'absolute', right: 13, top: 10, width: 9, height: THUMB_H, borderRadius: THUMB_H / 2, borderWidth: 2.5, borderColor: '#FFF', backgroundColor: 'rgba(120,120,128,0.18)', elevation: 2, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, zIndex: 6 },
  fastBubble: { position: 'absolute', right: 44, top: 10, minWidth: 72, maxWidth: 150, backgroundColor: c.bgElevated, borderRadius: 9, paddingVertical: 6, paddingHorizontal: 10, alignItems: 'center', elevation: 3, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, zIndex: 6 },
  fastBubbleText: { color: c.text, fontSize: 12, fontWeight: '600' },

  previewFooter: { alignItems: 'center', paddingBottom: 24 },
  previewSelectBtn: { backgroundColor: c.accent, borderRadius: 20, paddingHorizontal: 28, paddingVertical: 10 },
  previewSelectBtnOn: { backgroundColor: c.success },
  previewSelectDisabled: { backgroundColor: c.fillStrong },
  previewSelectText: { color: '#FFF', fontSize: 15, fontWeight: '600' },

  albumPanel: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: c.bgElevated, zIndex: 10, paddingTop: 8 },
  albumRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.divider },
  albumName: { flex: 1, fontSize: 15, color: c.text, marginRight: 12 },
  albumNameActive: { color: c.accent, fontWeight: '600' },
  albumNameMore: { color: c.accent },
  albumNameJunk: { color: c.textFaint },
  albumRowJunk: { opacity: 0.6 },
  albumCount: { fontSize: 13, color: c.textMuted },
  albumFilterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10, backgroundColor: c.bgSunken },
  albumFilterText: { fontSize: 12, color: c.textMuted },
  albumFilterBtn: { fontSize: 13, color: c.accent, fontWeight: '600' },

  limitedHint: { fontSize: 12, color: c.warnText, backgroundColor: c.warnSoft, margin: 8, padding: 10, borderRadius: 8, textAlign: 'center' },
  footer: { height: 44 },
  emptyText: { textAlign: 'center', color: c.textMuted, marginTop: 40 },
  deniedBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  deniedText: { fontSize: 15, color: c.text, textAlign: 'center' },
  hintText: { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 20 },
  retryBtn: { marginTop: 4, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: c.accent },
  retryText: { color: c.textOnAccent, fontSize: 15, fontWeight: '600' },
});
