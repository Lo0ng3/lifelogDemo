import React, { useState, useEffect, useMemo, useRef, useCallback, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  Dimensions, Modal, Alert, ActionSheetIOS, ActivityIndicator, Platform, ToastAndroid, InteractionManager
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import LiquidGlassSurface from '../components/LiquidGlassSurface';
import NativeIcon from '../components/NativeIcon';
import NativeLivePhoto, { hasNativeLivePhoto } from '../components/NativeLivePhoto';
import NativeVideoPlayer, { hasNativeVideoPlayer } from '../components/NativeVideoPlayer';
import {
  Star, StarHalf, X, PlayCircle, ChevronLeft, Edit3, Trash2
} from 'lucide-react-native';
import { Audio, Video, ResizeMode } from 'expo-av';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, runOnJS,
} from 'react-native-reanimated';

import { LogContext } from '../context/LogContext';
import { getIconConfig } from '../utils/icons';
import { isEssay, labelOf } from '../utils/recordMeta';
import { normalizeMediaEntry, resolveMediaUri, resolvePlayableVideoUri, getVideoPoster, getVideoThumbnail, isVideoEntry, remoteImageSource, downscaleCover, mediaSignature } from '../utils/media';
import { getLivePhotoInfo, extractMotionVideo } from '../utils/livePhoto';
import { shortTicketTitle } from '../utils/format';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { hapticLight, hapticSelection, hapticWarning } from '../utils/haptics';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const lightTap = hapticLight;

/* ---------------- 影像九宫格：长按拖动排序 ----------------
   交互约定（和"长按设为封面"共存，不靠任何角标/把手）：
     · 长按 260ms 后**移动** → 拖动换顺序：被拖的那张跟手，**滑到哪一格就插到那一格**，
       其余影像保持相对顺序、整体顺延补位（是"插入/搬移"，不是两张互换位置）；
     · 长按 260ms 后**原地松手** → 还是原来的「设为封面」菜单；
     · 轻点 → 打开全屏查看器（手势没达到长按时长就结束了，不会干扰点击）。
   几个容易出错的点（都已处理）：
     · 顺序按"条目身份"记而不是按下标——写回存储后记录里的条目会换成一批新对象，
       按下标记会被应用第二遍、落位后闪回旧排列；
     · 松手那一帧读的是同步维护的 orderRef（setState 可能还没提交，最后一格会被吞掉）；
     · 跟手位移和落点判定都只用「手指位移 + 格子序号」，不依赖屏幕坐标：
       列表滚动过、之前量到的位置过期也不会跳，落点永远和眼睛看到的一致；
     · 拖动期间锁住外层 ScrollView，否则手指一移动就被滚动容器抢走手势；
     · 拖动过程中只改本地顺序，松手才写回记录，避免拖一次写几十遍存储。 */
const GRID_COLS = 3;

function MediaGridCell({
  entry, displayIndex, originalIndex, coverOn, total, maxEnabled,
  cw, ch, onMove, onOpen, onIdleLongPress, onDragState, onPosterReady,
}) {
  const styles = useThemedStyles(makeStyles);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const active = useSharedValue(0);
  const pressed = useSharedValue(0);
  const started = useSharedValue(0);
  const moved = useSharedValue(0);
  const cur = useSharedValue(displayIndex);    // 当前所在格子（显示下标）
  const from = useSharedValue(displayIndex);   // 拖动开始那一刻所在的格子
  // 拖动中这个格子的 displayIndex 会跟着重排一起变；拖动期间以手势自己的 cur 为准，
  // 不让 prop 覆盖手势的进度（否则连着快拖时"从哪一格搬"会算错）
  useEffect(() => {
    if (!started.value) cur.value = displayIndex;
  }, [displayIndex, cur, started]);

  // 回调走 ref：拖动过程中父组件每次交换顺序都会重渲染，
  // 若把这些回调放进 useMemo 依赖里，手势会被反复重建、正在拖的那一下会断
  const cbRef = useRef({});
  cbRef.current = { onMove, onIdleLongPress, onDragState, onOpen, originalIndex };

  const cellGesture = useMemo(() => {
    // 落点判定：只看「手指从起点挪了多远」+ 起始格子，不碰屏幕坐标。
    // 被拖的这张是跟手的，它的位移正好等于手指位移，所以"这张影像的中心落在哪一格"
    // 就是 round(起始格 + 位移 / 格宽)。列表滚动过、之前量到的位置过期，都不会算错
    const targetOf = (dx, dy) => {
      'worklet';
      const col0 = from.value % GRID_COLS;
      const row0 = Math.floor(from.value / GRID_COLS);
      const col = Math.max(0, Math.min(GRID_COLS - 1, Math.round(col0 + dx / cw.value)));
      const row = Math.max(0, Math.round(row0 + dy / ch.value));
      return Math.max(0, Math.min(total.value - 1, row * GRID_COLS + col));
    };
    const pan = Gesture.Pan()
      .activateAfterLongPress(260)
      .onStart(() => {
        pressed.value = 0;
        started.value = 1;
        active.value = 1;
        moved.value = 0;
        from.value = cur.value;
        tx.value = 0;
        ty.value = 0;
        runOnJS(cbRef.current.onDragState)(true);
      })
      .onUpdate((e) => {
        // 14px 以内当作"手抖"，仍然算原地长按（弹封面菜单），避免误判成拖动
        if (Math.abs(e.translationX) > 14 || Math.abs(e.translationY) > 14) moved.value = 1;
        // 这张影像的中心落在哪一格，就把它插到哪一格（其余影像整体顺延补位）
        const target = targetOf(e.translationX, e.translationY);
        if (target !== cur.value) {
          runOnJS(cbRef.current.onMove)(cur.value, target);
          cur.value = target;
        }
        // 跟手：位移 = 手指的位移 + 「起始格 → 当前格」的位置差。
        // 两者都只跟格子序号和格宽有关——重排让本格换了位置时不会闪
        //（按手指绝对坐标直接算的老写法，格子在布局里换位那一下就会抖）
        const col = cur.value % GRID_COLS;
        const row = Math.floor(cur.value / GRID_COLS);
        const col0 = from.value % GRID_COLS;
        const row0 = Math.floor(from.value / GRID_COLS);
        tx.value = e.translationX + (col0 - col) * cw.value;
        ty.value = e.translationY + (row0 - row) * ch.value;
      })
      .onFinalize(() => {
        const didStart = started.value;
        const didMove = moved.value;
        started.value = 0;
        active.value = 0;
        moved.value = 0;
        tx.value = withTiming(0, { duration: 160 });
        ty.value = withTiming(0, { duration: 160 });
        if (!didStart) return;                      // 轻点/滚动：手势没激活，什么都不做
        runOnJS(cbRef.current.onDragState)(false);
        // 只有"确实长按到了、但没有移动"才算原来的长按（弹封面菜单）
        if (!didMove) runOnJS(cbRef.current.onIdleLongPress)();
      });
    // 用 RNGH 原生 Tap 与长按拖动竞争，彻底消除 ScrollView 内 GestureDetector 套 TouchableOpacity 在 iOS 掉点的问题
    const tap = Gesture.Tap()
      .maxDistance(12)
      .onBegin(() => { pressed.value = 1; })
      .onEnd((_e, success) => {
        if (success) runOnJS(cbRef.current.onOpen)(cbRef.current.originalIndex);
      })
      .onFinalize(() => { pressed.value = 0; });
    return Gesture.Race(pan, tap);
  }, [active, ch, cur, cw, from, moved, pressed, started, total, tx, ty]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: 1 + active.value * 0.06 },
    ],
    zIndex: active.value ? 20 : 0,
    opacity: active.value ? 0.92 : (pressed.value ? 0.8 : 1),
  }));

  return (
    <GestureDetector gesture={cellGesture}>
      <Animated.View style={[styles.gridItem, animStyle]}>
        <View>
          {isVideoEntry(entry) ? (
            <View style={styles.videoThumbnailBox}>
              <VideoThumb
                entry={entry}
                style={styles.gridImage}
                enabled={displayIndex < maxEnabled}
                onPosterReady={onPosterReady}
              />
              <View style={styles.playOverlay}><NativeIcon name="play.circle.fill" fallback={PlayCircle} size={30} color="#FFF" /></View>
            </View>
          ) : (
            <>
              <Image source={{ uri: entry.uri }} style={styles.gridImage} contentFit="cover" cachePolicy="memory" />
              <LiveGridBadge entry={entry} enabled={displayIndex < maxEnabled} />
            </>
          )}
          {coverOn && <View style={styles.coverBadge}><Text style={styles.coverBadgeText}>封面</Text></View>}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

function MediaGrid({ entries, coverIndex, maxEnabled = 9, onOpen, onIdleLongPress, onReorder, onDragChange, onPosterReady }) {
  const styles = useThemedStyles(makeStyles);

  // 顺序按"条目身份"记（相册引用 / 文件名+大小 / uri），不按下标：
  // 松手后父组件把影像按新顺序写回存储、entries 换成一批新对象，身份却没变，
  // 于是顺序不会被应用第二遍，落位后也不会闪回旧排列。
  // 身份相同的重复条目（同名同大小）再补一个序号，既稳定又不会撞 React key
  const itemKeys = useMemo(() => {
    const seen = new Map();
    return entries.map((e, i) => {
      const base = mediaSignature(e) || `#${i}`;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return n === 0 ? base : `${base}~${n}`;
    });
  }, [entries]);
  const keysRef = useRef(itemKeys);
  keysRef.current = itemKeys;

  const indexByKey = useMemo(() => {
    const map = new Map();
    itemKeys.forEach((k, i) => map.set(k, i));
    return map;
  }, [itemKeys]);

  const [order, setOrder] = useState(null);          // 身份数组；null = 自然顺序
  const orderRef = useRef(null);

  // 每格的边长：九宫格宽度 ÷ 3（每格是正方形）。只在布局变化时更新，
  // 与滚动位置无关，所以拖动过程中不会因为测量过期而算歪
  const cw = useSharedValue(1);
  const ch = useSharedValue(1);
  const total = useSharedValue(entries.length);
  useEffect(() => { total.value = entries.length; }, [entries.length, total]);
  const onGridLayout = useCallback((e) => {
    const w = e.nativeEvent.layout.width;
    cw.value = w / GRID_COLS;
    ch.value = w / GRID_COLS;
  }, [ch, cw]);

  // 展示顺序：拖动顺序优先，顺序里没有的（拖动期间新加进来的）按自然顺序补在后面
  const items = useMemo(() => {
    const out = [];
    const added = new Set();
    const push = (k) => {
      const i = indexByKey.get(k);
      if (i == null || added.has(k)) return;
      added.add(k);
      out.push({ key: k, entry: entries[i], originalIndex: i });
    };
    (order || itemKeys).forEach(push);
    itemKeys.forEach(push);
    return out;
  }, [order, itemKeys, indexByKey, entries]);

  // 存储已经跟上这份顺序（身份一一对应）就丢掉本地顺序，回到自然顺序走同一条路径
  useEffect(() => {
    if (!order) return;
    if (order.length === itemKeys.length && order.every((k, i) => k === itemKeys[i])) {
      orderRef.current = null;
      setOrder(null);
    }
  }, [order, itemKeys]);

  // 把 from 位置这张搬去 to：取出后插入，其余顺延（不是交换两张）
  const moveTo = useCallback((from, to) => {
    const base = orderRef.current || keysRef.current;
    if (from === to || from < 0 || to < 0 || from >= base.length || to >= base.length) return;
    const next = [...base];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    // 同步写一份：松手那一帧必须读到最新顺序（只靠 setState 的话，
    // 手势结束时那次更新可能还没提交，最后一格的移动就被吞掉了）
    orderRef.current = next;
    setOrder(next);
    lightTap();     // 每换一格给一次很轻的震动，"插到哪一格"是能摸出来的
  }, []);

  const handleDrop = useCallback(() => {
    const next = orderRef.current;
    // 只是长按没挪动（orderRef 还是 null）就不写回，留给"设为封面"那一次长按
    if (!next) return;
    // 交给父组件的是"原始下标"的排列：localImages 与九宫格条目一一对应，
    // 父组件按下标重排最稳妥（身份键只用来在这里记住拖动顺序）
    const permutation = next.map((k) => indexByKey.get(k)).filter((i) => i != null);
    if (permutation.length === next.length) onReorder?.(permutation);
  }, [indexByKey, onReorder]);

  // 拖动状态回报给父组件：拖动期间要锁住外层 ScrollView，
  // 否则手指一移动，滚动容器会把这一下抢走（顺序就拖不动了）
  const dragState = useCallback((on) => {
    if (on) onDragChange?.(true);
    else {
      handleDrop();
      onDragChange?.(false);
    }
  }, [handleDrop, onDragChange]);

  return (
    <View style={styles.imageGrid} onLayout={onGridLayout}>
      {items.map(({ key, entry, originalIndex }, pos) => (
        entry ? (
          <MediaGridCell
            key={key}
            entry={entry}
            displayIndex={pos}
            originalIndex={originalIndex}
            coverOn={coverIndex === originalIndex}
            total={total}
            maxEnabled={maxEnabled}
            cw={cw} ch={ch}
            onMove={moveTo}
            onOpen={onOpen}
            onIdleLongPress={() => onIdleLongPress(originalIndex)}
            onDragState={dragState}
            onPosterReady={onPosterReady}
          />
        ) : null
      ))}
    </View>
  );
}

// 详情查看器里的图片：捏合缩放 / 双击放大 / 放大后拖动。
// 视频仍走原生播放控件（全屏播放本身就是"放大看"），这里只管图片。
function ZoomableImage({ uri, active, onZoomChange, onSingleTap }) {
  const { width: winW, height: winH } = Dimensions.get('window');
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0), ty = useSharedValue(0);
  const savedTx = useSharedValue(0), savedTy = useSharedValue(0);
  // 当前有没有放大：既用于限制拖动，也用于"没放大时别抢横向手势"
  const [zoomed, setZoomed] = useState(false);
  const zoomedRef = useRef(false);
  // 回调装进 ref：notify 保持稳定引用，下面的 effect 才能安心把依赖写全（不会每次渲染都重跑）
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedScale.value = 1;
    savedTx.value = 0;
    savedTy.value = 0;
  };
  const notify = useCallback((on) => {
    zoomedRef.current = on;
    setZoomed(on);
    if (onZoomChangeRef.current) onZoomChangeRef.current(on);
  }, []);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => { scale.value = Math.min(6, Math.max(1, savedScale.value * e.scale)); })
    .onEnd(() => {
      if (scale.value <= 1.05) { reset(); runOnJS(notify)(false); return; }
      savedScale.value = scale.value;
      runOnJS(notify)(true);
    });
  /* 放大之后才允许拖动，并且限制在图片范围内（避免把图拖出屏幕外找不回来）。
     `.enabled(zoomed)` 很关键：没放大时这个 pan 绝不能接管触摸，否则查看器的
     横向翻页（FlatList 的 pagingEnabled）会被它吃掉 —— 表现就是"静态图滑不动"。 */
  const pan = Gesture.Pan()
    .enabled(zoomed)
    .onUpdate((e) => {
      if (savedScale.value <= 1.05) return;
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      const maxX = ((savedScale.value - 1) * winW) / 2;
      const maxY = ((savedScale.value - 1) * winH) / 2;
      tx.value = withTiming(Math.max(-maxX, Math.min(maxX, tx.value)));
      ty.value = withTiming(Math.max(-maxY, Math.min(maxY, ty.value)));
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (savedScale.value > 1.05) { reset(); runOnJS(notify)(false); return; }
      scale.value = withTiming(2.5);
      savedScale.value = 2.5;
      runOnJS(notify)(true);
    });
  const handleSingleTap = () => {
    if (zoomedRef.current) return;
    if (onSingleTap) onSingleTap();
  };
  // 单击（只有传了 onSingleTap 才用，比如实况照片"点一下播动效"）：
  // 用 Exclusive 排它，双击优先，单击等双击失败后才算数；放大状态下单击不做事
  const singleTap = Gesture.Tap()
    .onEnd((_e, success) => {
      'worklet';
      if (!success) return;
      runOnJS(handleSingleTap)();
    });
  const gesture = Gesture.Simultaneous(
    pinch,
    pan,
    onSingleTap ? Gesture.Exclusive(doubleTap, singleTap) : doubleTap
  );
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // 翻到别的影像时把这一张的缩放还原，回来时不会莫名其妙还是放大的
  useEffect(() => {
    if (!active) {
      scale.value = 1; savedScale.value = 1;
      tx.value = 0; ty.value = 0;
      savedTx.value = 0; savedTy.value = 0;
      // 翻走时要把"正在放大"的状态也报回去，否则查看器的翻页会一直被锁着
      if (zoomedRef.current) notify(false);
    }
  }, [active, scale, savedScale, tx, ty, savedTx, savedTy, notify]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ width: '100%', height: '100%' }, animStyle]}>
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" cachePolicy="memory" />
      </Animated.View>
    </GestureDetector>
  );
}

// 视频封面：只生成一次封面帧（内存缓存），避免为了一张缩略图挂载真实播放器
function VideoThumb({ entry, style, contentFit = 'cover', enabled = true, onPosterReady }) {
  const [thumb, setThumb] = useState(null);
  const embeddedPoster = entry?.videoPoster?.base64;
  const posterUri = entry?.videoPoster?.uri;
  useEffect(() => {
    if (embeddedPoster || posterUri) return undefined;
    if (!enabled) return undefined;
    let alive = true;
    // 等导航/布局动画结束再解码视频帧，避免一进详情就把解码器占满
    const task = InteractionManager.runAfterInteractions(() => {
      getVideoPoster(entry).then((poster) => {
        if (!alive || (!poster?.uri && !poster?.base64)) return;
        setThumb(poster.uri || `data:${poster.mime || 'image/jpeg'};base64,${poster.base64}`);
        onPosterReady?.(entry, poster);
      });
    });
    return () => { alive = false; task.cancel(); };
  }, [entry, enabled, embeddedPoster, posterUri, onPosterReady]);
  if (posterUri) {
    return <Image source={{ uri: posterUri }} style={style} contentFit={contentFit} cachePolicy="memory-disk" />;
  }
  if (embeddedPoster) {
    return (
      <Image
        source={{ uri: `data:${entry.videoPoster.mime || 'image/jpeg'};base64,${embeddedPoster}` }}
        style={style}
        contentFit={contentFit}
        cachePolicy="memory"
      />
    );
  }
  if (!enabled) return null;
  if (!thumb) return null;
  return <Image source={{ uri: thumb }} style={style} contentFit={contentFit} cachePolicy="memory" />;
}

// 实况徽标：异步检测动态照片，是实况才显示；详情内用全量模式（结果持久缓存，只算一次）
function LiveGridBadge({ entry, enabled = true }) {
  const styles = useThemedStyles(makeStyles);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (entry?.liveStatus === 'live') {
      setLive(true);
      return undefined;
    }
    // iOS 上如果 liveSource 不是 'ios'（例如老数据或从 Android 导入的备份），不信任旧的 'not-live'，用 PhotoKit 重检一次
    if (entry?.liveStatus === 'not-live' && !(Platform.OS === 'ios' && entry?.assetId && entry?.liveSource !== 'ios')) {
      setLive(false);
      return undefined;
    }
    if (!enabled) return undefined;
    let alive = true;
    // 网格只做廉价检测。以前这里对每张图都 full 扫描并预提取实况视频，
    // 一组实况照片会连续读文件、写 mp4，打开详情和返回都会被拖慢。
    const task = InteractionManager.runAfterInteractions(() => {
      getLivePhotoInfo(entry, { full: false }).then(i => {
        if (alive) setLive(!!i?.live);
      });
    });
    return () => { alive = false; task.cancel(); };
  }, [entry, enabled]);
  if (entry?.liveStatus === 'live') {
    return <View style={styles.liveBadge}><Text style={styles.liveBadgeText}>实况</Text></View>;
  }
  if (!enabled || (entry?.liveStatus === 'not-live' && !(Platform.OS === 'ios' && entry?.assetId && entry?.liveSource !== 'ios'))) return null;
  if (!live) return null;
  return <View style={styles.liveBadge}><Text style={styles.liveBadgeText}>实况</Text></View>;
}

// 全屏查看器里的实况照片页：
// - iOS 相册实况原片：直接使用苹果原生 PHLivePhotoView（零文件导出，支持系统原生任意位置长按 & 单击播放）；
// - 普通照片与 Android 动态照片：走可缩放静帧 + 按需提取播放。
function LivePhotoPage({ entry, active, onZoomChange }) {
  const styles = useThemedStyles(makeStyles);
  const [info, setInfo] = useState(null);
  const [playingUri, setPlayingUri] = useState(null);
  const [videoReady, setVideoReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nativePlaying, setNativePlaying] = useState(false);
  const [nativePlayTrigger, setNativePlayTrigger] = useState(0);
  const [nativeFailed, setNativeFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setPlayingUri(null);
    setVideoReady(false);
    setNativePlaying(false);
    setNativePlayTrigger(0);
    setNativeFailed(false);
    if (entry?.liveStatus === 'not-live' && !(Platform.OS === 'ios' && entry?.assetId && entry?.liveSource !== 'ios')) {
      setInfo({ live: false });
      return () => { alive = false; };
    }
    if (Platform.OS === 'ios' && entry?.liveStatus === 'live') {
      setInfo({ live: true, source: 'ios' });
      return () => { alive = false; };
    }
    getLivePhotoInfo(entry, { full: true }).then(i => {
      if (!alive) return;
      setInfo(i);
    });
    return () => { alive = false; };
  }, [entry]);

  const isLive = !!info?.live;
  const useNativeLive = Platform.OS === 'ios' && hasNativeLivePhoto && isLive && !!entry?.assetId && !nativeFailed;

  const handlePlay = async () => {
    if (loading || playingUri) return;
    setLoading(true);
    try {
      const uri = await extractMotionVideo(entry, info);
      if (uri) { setVideoReady(false); setPlayingUri(uri); }
      else if (Platform.OS === 'android') {
        ToastAndroid.show('实况动效读取失败，先看静帧吧（可在侧边栏「数据目录」查看）', ToastAndroid.LONG);
      } else {
        Alert.alert('无法播放实况', '实况动效读取失败，可能尚未从 iCloud 下载或已移除。');
      }
    } finally {
      setLoading(false);
    }
  };

  if (useNativeLive) {
    return (
      <View style={{ width: '100%', height: '80%', alignItems: 'center', justifyContent: 'center' }}>
        <Image source={{ uri: entry.uri }} style={StyleSheet.absoluteFill} contentFit="contain" cachePolicy="memory" />
        <NativeLivePhoto
          assetId={entry.assetId}
          active={active}
          playTrigger={nativePlayTrigger}
          onPlaybackChange={setNativePlaying}
          onLoadState={(s) => { if (s?.error) setNativeFailed(true); }}
          style={StyleSheet.absoluteFill}
        />
        {!nativePlaying && (
          <TouchableOpacity
            style={styles.livePlayBadge}
            activeOpacity={0.8}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            onPress={() => {
              hapticSelection();
              setNativePlayTrigger((n) => n + 1);
            }}
          >
            <NativeIcon name="livephoto" fallback={PlayCircle} size={15} color="#FFF" style={{ marginRight: 5 }} />
            <Text style={styles.livePlayText}>实况 · 轻点或长按</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  /* 普通照片和 Android 动态照片的静帧都用同一个可缩放视图（双指捏合 / 双击放大 / 放大后拖动）。
     实况多传一个 onSingleTap：没放大时点一下 = 播动效（放大状态下单击不触发，避免误播）。 */
  return (
    <View style={{ width: '100%', height: '80%', alignItems: 'center', justifyContent: 'center' }}>
      <ZoomableImage
        uri={entry.uri}
        active={active}
        onZoomChange={onZoomChange}
        onSingleTap={isLive && !videoReady ? handlePlay : undefined}
      />
      {/* 角标只是提示，别挡手势（点播交给上面的 onSingleTap） */}
      {isLive && !videoReady && (
        <View style={styles.livePlayBadge} pointerEvents="none">
          {loading ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Text style={styles.livePlayText}>实况</Text>
              <NativeIcon name="livephoto" fallback={PlayCircle} size={16} color="#FFF" />
            </>
          )}
        </View>
      )}
      {playingUri && (
        <View
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: videoReady ? 1 : 0 }}
          pointerEvents={videoReady ? 'auto' : 'none'}
        >
          <Video
            source={{ uri: playingUri }}
            style={{ width: '100%', height: '100%' }}
            useNativeControls
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
            onPlaybackStatusUpdate={(s) => {
              if (!s.isLoaded) return;
              setVideoReady(true);
              // 播完回到封面帧，再次点按可重播
              if (s.didJustFinish) { setPlayingUri(null); setVideoReady(false); }
            }}
          />
        </View>
      )}
    </View>
  );
}

// 全屏查看器里的视频页：
// - iOS：直接使用苹果原生 AVPlayerViewController（PhotoKit 流式播放，零拷贝秒开，支持 PiP / AirPlay / HDR）；
// - Android：按需解析并挂载 expo-av 播放器。
function VideoPlayerPage({ entry, active }) {
  const styles = useThemedStyles(makeStyles);
  const [playableUri, setPlayableUri] = useState(null);
  const [failed, setFailed] = useState(false);
  const [nativeStatus, setNativeStatus] = useState('loading');

  const useNativePlayer = Platform.OS === 'ios' && hasNativeVideoPlayer;

  useEffect(() => {
    if (useNativePlayer) {
      if (!active) setNativeStatus('loading');
      return undefined;
    }
    if (!active) {
      setPlayableUri(null);
      setFailed(false);
      return undefined;
    }
    let alive = true;
    setFailed(false);
    resolvePlayableVideoUri(entry)
      .then((u) => {
        if (!alive) return;
        if (u && !u.startsWith('ph://')) setPlayableUri(u);
        else setFailed(true);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [active, entry, useNativePlayer]);

  if (!active) {
    return (
      <View style={{ width: '100%', height: '80%', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        <VideoThumb entry={entry} style={{ width: '100%', height: '100%' }} contentFit="contain" />
      </View>
    );
  }

  if (useNativePlayer) {
    return (
      <View style={{ width: '100%', height: '80%', justifyContent: 'center', alignItems: 'center' }}>
        {nativeStatus !== 'ready' && (
          <VideoThumb entry={entry} style={StyleSheet.absoluteFill} contentFit="contain" />
        )}
        <NativeVideoPlayer
          assetId={entry?.assetId || null}
          uri={entry?.uri || null}
          active={active}
          onStatusChange={(s) => {
            if (s?.status) setNativeStatus(s.status);
          }}
          style={{ width: '100%', height: '100%' }}
        />
        {nativeStatus === 'loading' && (
          <View style={styles.playOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#FFF" />
          </View>
        )}
        {nativeStatus === 'error' && (
          <View style={styles.playOverlay} pointerEvents="none">
            <Text style={styles.videoErrorText}>视频无法播放（可能未从 iCloud 下载或已移除）</Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={{ width: '100%', height: '80%', justifyContent: 'center', alignItems: 'center' }}>
      <VideoThumb entry={entry} style={StyleSheet.absoluteFill} contentFit="contain" />
      {playableUri ? (
        <Video
          source={{ uri: playableUri }}
          style={{ width: '100%', height: '100%' }}
          useNativeControls
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          onError={(e) => {
            console.warn('[video] 播放失败', playableUri, e);
            setFailed(true);
          }}
        />
      ) : failed ? (
        <View style={styles.playOverlay}>
          <Text style={styles.videoErrorText}>视频无法播放（可能未从 iCloud 下载或已移除）</Text>
        </View>
      ) : (
        <View style={styles.playOverlay}>
          <ActivityIndicator size="large" color="#FFF" />
        </View>
      )}
    </View>
  );
}

export default function DetailScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { logData, updateLog, deleteLog, saveVideoPoster } = useContext(LogContext);

  // 通过 id 从全局数据里取，编辑/删除后页面能自动同步
  const itemId = route.params?.item?.id;
  const item = useMemo(
    () => logData.find(l => l.id === itemId),
    [logData, itemId]
  );

  const [viewerIndex, setViewerIndex] = useState(-1);
  const [currentViewIndex, setCurrentViewIndex] = useState(-1);

  // iOS 静音开关打开时 expo-av 默认静音；打开详情页配置音频会话，确保视频与实况照片正常出声
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
  }, []);
  // 图片放大后要禁用横向翻页，否则捏合/拖动会和翻页抢手势
  const [viewerZoomed, setViewerZoomed] = useState(false);
  // 九宫格正在拖动排序：期间锁住外层 ScrollView，不然滚动容器会把手势抢走
  const [gridDragging, setGridDragging] = useState(false);

  const onViewableItemsChanged = useMemo(
    () => ({ viewableItems }) => {
      if (viewableItems.length > 0) {
        setCurrentViewIndex(viewableItems[0].index);
        setViewerZoomed(false);
      }
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

  // 首屏先做前 9 张，随后每 450ms 放 6 张进来。
  // 这样不会一次把几十个视频帧全塞给解码器，也不会出现第 10 张以后永远没有封面。
  const [mediaReadyCount, setMediaReadyCount] = useState(9);
  useEffect(() => {
    const total = resolvedMedia.length;
    setMediaReadyCount(Math.min(9, total));
    if (total <= 9) return undefined;
    let count = 9;
    const timer = setInterval(() => {
      count = Math.min(total, count + 6);
      setMediaReadyCount(count);
      if (count >= total) clearInterval(timer);
    }, 450);
    return () => clearInterval(timer);
  }, [resolvedMedia.length, item?.id]);

  // 封面：优先直接用已生成的 360px 缩略图（coverThumbUrl），其次相册自选图 / 封面地址
  const coverEntry = item?.coverIndex != null ? resolvedMedia[item.coverIndex] : null;
  const [coverUri, setCoverUri] = useState(null);
  useEffect(() => {
    let alive = true;
    if (coverEntry && !item?.coverThumbUrl) {
      resolveMediaUri(coverEntry).then(u => { if (alive) setCoverUri(u); });
    } else {
      setCoverUri(null);
    }
    return () => { alive = false; };
  }, [coverEntry, item?.coverThumbUrl]);
  const coverSource = item?.coverThumbUrl
    ? remoteImageSource(item.coverThumbUrl)
    : (coverUri ? { uri: coverUri } : (item?.coverUrl ? remoteImageSource(item.coverUrl) : null));

  const itemIdRef = useRef(item?.id);
  itemIdRef.current = item?.id;
  const saveVideoPosterRef = useRef(saveVideoPoster);
  saveVideoPosterRef.current = saveVideoPoster;
  const handleVideoPosterReady = useCallback((entry, poster) => {
    if (!poster?.uri && !poster?.base64) return;
    if (itemIdRef.current != null) {
      saveVideoPosterRef.current?.(itemIdRef.current, entry, poster);
    }
  }, []);

  // 封面：长按九宫格里任意一张设为/取消封面，记录在 coverIndex 上。
  // 设为封面时同步生成小图文件（covers/ 目录），列表/详情直接显示，重启无需重新解析相册
  const handleGridLongPress = (idx) => {
    const isCurrentCover = item.coverIndex === idx;
    const applyCover = async () => {
      let coverThumbUrl = null;
      try {
        const entry = normalizeMediaEntry(item.localImages?.[idx]);
        let coverInput = null;
        if (isVideoEntry(entry)) {
          coverInput = entry?.videoPoster?.uri || await getVideoThumbnail(entry);
        } else if (Platform.OS === 'ios' && entry?.assetId) {
          coverInput = `ph://${entry.assetId}`;
        } else {
          const resolved = await resolveMediaUri(entry);
          coverInput = resolved || entry?.uri;
        }
        if (coverInput) coverThumbUrl = await downscaleCover(coverInput);
      } catch {}
      updateLog({ ...item, coverIndex: idx, coverThumbUrl: coverThumbUrl || null });
    };
    const clearCover = () => updateLog({ ...item, coverIndex: null, coverThumbUrl: null });

    if (Platform.OS === 'ios') {
      hapticSelection();
      const hasCover = item.coverIndex != null;
      const options = hasCover
        ? [isCurrentCover ? '重新设为封面' : '设为封面', '取消封面', '取消']
        : ['设为封面', '取消'];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: '封面设置',
          options,
          destructiveButtonIndex: hasCover ? 1 : undefined,
          cancelButtonIndex: options.length - 1,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) applyCover();
          else if (hasCover && buttonIndex === 1) clearCover();
        }
      );
      return;
    }

    Alert.alert('封面设置', '将这张照片设为该记录的封面吗？', [
      { text: '取消', style: 'cancel' },
      ...(item.coverIndex != null
        ? [{ text: '取消封面', style: 'destructive', onPress: clearCover }]
        : []),
      {
        text: isCurrentCover ? '重新设为封面' : '设为封面',
        onPress: applyCover,
      },
    ]);
  };

  // 拖动排序写回：把 localImages 按新顺序重排，并把"封面是哪一张"跟着搬到新下标
  // （封面小图文件对应的是同一张影像，所以 coverThumbUrl 不用动）
  const handleMediaReorder = (permutation) => {
    const raw = item.localImages || [];
    const nextImages = permutation.map((i) => raw[i]).filter(Boolean);
    if (!nextImages.length || nextImages.length !== raw.length) return;
    const patch = { ...item, localImages: nextImages };
    if (typeof item.coverIndex === 'number') {
      const coverEntry = raw[item.coverIndex];
      const moved = coverEntry === undefined ? -1 : nextImages.indexOf(coverEntry);
      patch.coverIndex = moved >= 0 ? moved : null;
    }
    updateLog(patch);
  };

  if (!item) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 20 }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Text style={styles.emptyText}>这条印记已不存在</Text>
      </View>
    );
  }

  const iconConfig = getIconConfig(item, colors);
  const displayTitle = item.baseType === 'ticket' ? shortTicketTitle(item.title) : item.title;
  const essay = isEssay(item);
  const ticketNo = item.baseType === 'ticket' ? (item.subtitle || '') : '';
  const noteText = item.baseType === 'ticket'
    ? (item.comment || '')
    : (item.subtitle || item.comment || '');
  const isPortraitPoster = item.baseType === 'media' && item.coverIndex == null && !!item.coverUrl && (!item.coverRatio || item.coverRatio < 0.85);
  const heroDate = (() => {
    const [datePart, timePart] = String(item.date || '').split(' ');
    const [year, month, day] = datePart.split('-').map(Number);
    if (!year) return item.date || '';
    return `${year}年${month}月${day}日${timePart ? ` · ${timePart}` : ''}`;
  })();
  const handleEdit = () => {
    hapticSelection();
    navigation.push('Edit', { editItem: item });
  };
  const confirmDelete = () => {
    if (Platform.OS === 'ios') {
      hapticWarning();
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: `确定要删除「${displayTitle}」吗？`,
          message: '删除后无法恢复。',
          options: ['删除印记', '取消'],
          destructiveButtonIndex: 0,
          cancelButtonIndex: 1,
        },
        async (buttonIndex) => {
          if (buttonIndex === 0) {
            await deleteLog(item.id);
            navigation.goBack();
          }
        }
      );
      return;
    }
    Alert.alert('删除印记', `确定要删除「${displayTitle}」吗？删除后无法恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deleteLog(item.id);
          navigation.goBack();
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <StatusBar style={viewerIndex >= 0 ? 'light' : (isDark ? 'light' : 'dark')} />

      {/* 顶部简洁导航栏：左侧液态玻璃返回键 + 居中轻量类型徽标 */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.fixedBack}>
          <LiquidGlassSurface cornerRadius={19} isDark={isDark} interactive />
          <TouchableOpacity
            style={styles.fixedBackBtn}
            onPress={() => navigation.goBack()}
            activeOpacity={0.82}
            delayPressIn={0}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <NativeIcon name="chevron.left" fallback={ChevronLeft} size={20} color={colors.text} weight="semibold" />
          </TouchableOpacity>
        </View>
        <View style={[styles.topTypePill, Platform.OS !== 'ios' && { backgroundColor: iconConfig.iconBgColor }]}>
          {Platform.OS === 'ios' && <LiquidGlassSurface cornerRadius={14} isDark={isDark} interactive={false} />}
          <Text style={[styles.topTypeText, { color: iconConfig.iconColor }]}>{labelOf(item)}</Text>
        </View>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        bounces={Platform.OS === 'ios'}
        scrollEnabled={!gridDragging}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(118, insets.bottom + 98) }]}
      >
        {/* 头部信息卡：克制小封面 + 标题 / 日期 / 评分或心情（告别占满半屏的大横幅） */}
        <View style={styles.headerCard}>
          {coverSource ? (
            <TouchableOpacity
              activeOpacity={item.coverIndex != null ? 0.85 : 1}
              disabled={item.coverIndex == null}
              onPress={() => {
                if (item.coverIndex != null) {
                  setViewerIndex(item.coverIndex);
                  setCurrentViewIndex(item.coverIndex);
                }
              }}
              style={[styles.coverThumbWrap, isPortraitPoster && styles.coverThumbPoster]}
            >
              <Image source={coverSource} style={StyleSheet.absoluteFill} contentFit="cover" transition={160} cachePolicy="memory-disk" />
            </TouchableOpacity>
          ) : (
            <View style={[styles.iconThumb, { backgroundColor: iconConfig.iconBgColor }]}>
              <iconConfig.IconComponent color={iconConfig.iconColor} size={28} />
            </View>
          )}

          <View style={styles.headerInfo}>
            <Text style={styles.detailTitle} numberOfLines={3}>{displayTitle}</Text>
            {!!ticketNo && (
              <View style={styles.ticketNoRow}>
                <Text style={styles.ticketNoText}>{ticketNo}</Text>
              </View>
            )}
            <Text style={styles.detailDate}>{heroDate}</Text>
            <View style={styles.reviewRow}>
              {essay ? (
                <>
                  <Text style={styles.moodEmoji}>{item.mood || '📝'}</Text>
                  {!!item.weather && <Text style={styles.moodWeather}>· {item.weather}</Text>}
                </>
              ) : item.rating ? (
                <>
                  {[1, 2, 3, 4, 5].map((i) => {
                    const isFull = i <= item.rating;
                    const isHalf = i === Math.ceil(item.rating) && !Number.isInteger(item.rating);
                    if (isHalf) return <StarHalf key={i} size={16} color={colors.star} fill={colors.star} style={{ marginRight: 2 }} />;
                    return <Star key={i} size={16} color={isFull ? colors.star : colors.starEmpty} fill={isFull ? colors.star : 'transparent'} style={{ marginRight: 2 }} />;
                  })}
                  <Text style={styles.reviewScore}>{item.rating} 分</Text>
                </>
              ) : (
                <Text style={styles.mutedScore}>未评分</Text>
              )}
            </View>
          </View>
        </View>

        {/* 正文 / 评论卡 */}
        {!!noteText && (
          <View style={styles.noteCard}>
            <Text style={styles.reviewText}>{noteText}</Text>
          </View>
        )}

        {/* 照片九宫格（首屏即见，长按可拖动排序或设为封面） */}
        {resolvedMedia.length > 0 && (
          <View style={styles.mediaCard}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>照片</Text>
              <Text style={styles.sectionCount}>{resolvedMedia.length} 张</Text>
            </View>
            <MediaGrid
              entries={resolvedMedia}
              coverIndex={item.coverIndex}
              maxEnabled={mediaReadyCount}
              onPosterReady={handleVideoPosterReady}
              onOpen={(idx) => { setViewerIndex(idx); setCurrentViewIndex(idx); }}
              onIdleLongPress={handleGridLongPress}
              onReorder={handleMediaReorder}
              onDragChange={setGridDragging}
            />
          </View>
        )}
      </ScrollView>

      {/* 底部操作条：与底部液态玻璃导航栏统一外观 */}
      <View pointerEvents="box-none" style={[styles.actionWrap, { bottom: Math.max(18, insets.bottom - 6) }]}>
        <View style={styles.actionShadow}>
          <View style={styles.actionBar}>
            <LiquidGlassSurface cornerRadius={30} isDark={isDark} interactive />
            <TouchableOpacity style={styles.actionBtn} onPress={handleEdit} activeOpacity={0.75} delayPressIn={0}>
              <NativeIcon name="pencil" fallback={Edit3} size={17} color={colors.accent} />
              <Text style={[styles.actionText, { color: colors.accent }]}>修改</Text>
            </TouchableOpacity>
            <View style={[styles.actionDivider, { backgroundColor: colors.border }]} />
            <TouchableOpacity style={styles.actionBtn} onPress={confirmDelete} activeOpacity={0.75} delayPressIn={0}>
              <NativeIcon name="trash" fallback={Trash2} size={17} color={colors.danger} />
              <Text style={[styles.actionText, { color: colors.danger }]}>删除</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* 全屏图片/视频查看器 */}
      <Modal
        visible={viewerIndex >= 0}
        transparent
        animationType="fade"
        statusBarTranslucent={true}
        onRequestClose={() => { setViewerIndex(-1); setCurrentViewIndex(-1); setViewerZoomed(false); }}
      >
        {/* RN 的 Modal 在 Android 上是独立窗口，手势库的根上下文不会自动继承，
            里面必须自己再包一层 GestureHandlerRootView，否则捏合缩放/双击放大根本不生效 */}
        <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.viewerContainer}>
          <TouchableOpacity
            style={[styles.viewerCloseBtn, { top: insets.top + 10 }]}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            onPress={() => { setViewerIndex(-1); setCurrentViewIndex(-1); setViewerZoomed(false); }}
          >
            <NativeIcon name="xmark" fallback={X} size={24} color="#FFF" weight="semibold" />
          </TouchableOpacity>

          <FlatList
            data={resolvedMedia}
            keyExtractor={(_, i) => i.toString()}
            horizontal
            pagingEnabled
            scrollEnabled={!viewerZoomed}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={viewerIndex >= 0 ? viewerIndex : 0}
            getItemLayout={(_, index) => ({ length: SCREEN_WIDTH, offset: SCREEN_WIDTH * index, index })}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            renderItem={({ item: entry, index }) => (
              <View style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT, justifyContent: 'center' }}>
                {isVideoEntry(entry) ? (
                  <VideoPlayerPage entry={entry} active={index === currentViewIndex} />
                ) : (
                  <LivePhotoPage entry={entry} active={index === currentViewIndex} onZoomChange={setViewerZoomed} />
                )}
              </View>
            )}
          />
        </View>
        </GestureHandlerRootView>
      </Modal>
    </View>
  );
}

const makeStyles = (c) => ({
  container: { flex: 1, backgroundColor: c.bg },
  emptyText: { textAlign: 'center', color: c.textMuted, fontSize: 15 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 10, backgroundColor: c.bg,
  },
  fixedBack: {
    width: 38, height: 38, borderRadius: 19,
    overflow: Platform.OS === 'ios' ? 'visible' : 'hidden',
    shadowColor: c.shadow, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: Platform.OS === 'ios' ? 0.06 : 0.1, shadowRadius: 8, elevation: 3,
  },
  fixedBackBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  topTypePill: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
  },
  topTypeText: { fontSize: 12.5, fontWeight: '600' },
  scrollContent: { paddingHorizontal: 16, paddingTop: 4, gap: 14 },
  headerCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: c.bgElevated, borderRadius: 18, padding: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  coverThumbWrap: {
    width: 82, height: 82, borderRadius: 12, overflow: 'hidden',
    backgroundColor: c.mediaPlaceholder, flexShrink: 0,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  coverThumbPoster: { width: 72, height: 102, borderRadius: 11 },
  iconThumb: {
    width: 64, height: 64, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  headerInfo: { flex: 1, minWidth: 0 },
  detailTitle: { fontSize: 21, lineHeight: 27, fontWeight: '700', letterSpacing: -0.4, color: c.textStrong },
  ticketNoRow: { flexDirection: 'row', marginTop: 4 },
  ticketNoText: {
    fontSize: 12, fontWeight: '600', color: c.textSecondary,
    backgroundColor: c.bgSunken, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },
  detailDate: { fontSize: 13, color: c.textMuted, marginTop: 5, fontVariant: ['tabular-nums'] },
  reviewRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 8, minHeight: 22 },
  reviewScore: { marginLeft: 6, fontSize: 13, fontWeight: '700', color: c.textSecondary, fontVariant: ['tabular-nums'] },
  mutedScore: { fontSize: 12.5, color: c.textMuted },
  moodEmoji: { fontSize: 20, lineHeight: 24, marginRight: 4 },
  moodWeather: { fontSize: 13, color: c.textSecondary },
  noteCard: {
    backgroundColor: c.bgElevated, borderRadius: 16, paddingHorizontal: 18, paddingVertical: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  reviewText: { fontSize: 15.5, color: c.text, lineHeight: 25 },
  mediaCard: {
    backgroundColor: c.bgElevated, borderRadius: 16, padding: 14,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, paddingHorizontal: 2 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  sectionCount: { fontSize: 13, color: c.textMuted, fontVariant: ['tabular-nums'] },
  actionWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 35 },
  actionShadow: {
    width: 232, height: 60, borderRadius: 30,
    shadowColor: c.shadow, shadowOffset: { width: 0, height: 10 },
    shadowOpacity: Platform.OS === 'ios' ? 0.09 : 0.18, shadowRadius: 22, elevation: 9,
  },
  actionBar: {
    width: 232, height: 60, borderRadius: 30,
    overflow: Platform.OS === 'ios' ? 'visible' : 'hidden',
    flexDirection: 'row', alignItems: 'center',
    borderWidth: Platform.OS === 'ios' ? 0 : StyleSheet.hairlineWidth, borderColor: c.border,
  },
  videoErrorText: {
    color: '#FFF', fontSize: 13, backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, overflow: 'hidden',
  },
  actionBtn: { flex: 1, height: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  actionText: { fontSize: 12, fontWeight: '600' },
  actionDivider: { width: StyleSheet.hairlineWidth, height: 22 },
  coverBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  coverBadgeText: { color: '#FFF', fontSize: 10 },
  liveBadge: { position: 'absolute', left: 8, top: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  liveBadgeText: { color: '#FFF', fontSize: 10 },
  livePlayBadge: { position: 'absolute', right: 16, bottom: 16, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  livePlayText: { color: '#FFF', fontSize: 12, marginRight: 5 },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginTop: 8 },
  gridItem: { width: '33.33%', padding: 4 },
  gridImage: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: c.mediaPlaceholder },
  videoThumbnailBox: { width: '100%', aspectRatio: 1, borderRadius: 10, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: c.mediaPlaceholder },
  playOverlay: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  viewerContainer: { flex: 1, backgroundColor: '#000' },
  viewerCloseBtn: { position: 'absolute', zIndex: 10, right: 16 },
});
