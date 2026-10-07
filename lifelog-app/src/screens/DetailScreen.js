import React, { useState, useEffect, useMemo, useRef, useCallback, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  Dimensions, Modal, Alert, ActivityIndicator, Platform, ToastAndroid
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import {
  Star, StarHalf, X, PlayCircle, ChevronLeft
} from 'lucide-react-native';
import { Video, ResizeMode } from 'expo-av';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  FadeInDown, useSharedValue, useAnimatedStyle, withTiming, runOnJS,
} from 'react-native-reanimated';

import { LogContext } from '../context/LogContext';
import CoverIcon from '../components/CoverIcon';
import { getIconConfig } from '../utils/icons';
import { isEssay, labelOf } from '../utils/recordMeta';
import { normalizeMediaEntry, resolveMediaUri, getVideoThumbnail, isVideoEntry, remoteImageSource, downscaleCover, mediaSignature } from '../utils/media';
import { getLivePhotoInfo, extractMotionVideo } from '../utils/livePhoto';
import { shortTicketTitle } from '../utils/format';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// 震动反馈：模块缺失（旧构建）时静默跳过，不影响功能。
// 拖动换格时给一次极轻的反馈，用户能"摸到"影像插到哪一格了
let Haptics = null;
try { Haptics = require('expo-haptics'); } catch {}
const lightTap = () => { try { Haptics?.impactAsync?.(Haptics.ImpactFeedbackStyle.Light); } catch {} };

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
  entry, displayIndex, originalIndex, coverOn, total,
  cw, ch, onMove, onOpen, onIdleLongPress, onDragState,
}) {
  const styles = useThemedStyles(makeStyles);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const active = useSharedValue(0);
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
  cbRef.current = { onMove, onIdleLongPress, onDragState, onOpen };

  const pan = useMemo(() => {
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
    return Gesture.Pan()
      .activateAfterLongPress(260)
      .onStart(() => {
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
  }, [active, ch, cur, cw, from, moved, started, total, tx, ty]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: 1 + active.value * 0.06 },
    ],
    zIndex: active.value ? 20 : 0,
    opacity: active.value ? 0.92 : 1,
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.gridItem, animStyle]}>
        <TouchableOpacity activeOpacity={0.85} onPress={() => onOpen(originalIndex)}>
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
          {coverOn && <View style={styles.coverBadge}><Text style={styles.coverBadgeText}>封面</Text></View>}
        </TouchableOpacity>
      </Animated.View>
    </GestureDetector>
  );
}

function MediaGrid({ entries, coverIndex, onOpen, onIdleLongPress, onReorder, onDragChange }) {
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
            cw={cw} ch={ch}
            onMove={moveTo}
            onOpen={onOpen}
            onIdleLongPress={() => onIdleLongPress(originalIndex)}
            onDragState={dragState}
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

// 实况徽标：异步检测动态照片，是实况才显示；详情内用全量模式（结果持久缓存，只算一次）
function LiveGridBadge({ entry }) {
  const styles = useThemedStyles(makeStyles);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let alive = true;
    getLivePhotoInfo(entry, { full: true }).then(i => {
      if (!alive) return;
      setLive(!!i?.live);
      // 进详情页就把内嵌动效提取好（后台跑、失败不影响静帧）：点播放 / 全屏播放时直接命中。
      // 提取只读文件尾那几 MB，成本很低；文件在进后台时会被整体清掉，不会长期占空间。
      if (i?.live) extractMotionVideo(entry, i).catch(() => {});
    });
    return () => { alive = false; };
  }, [entry]);
  if (!live) return null;
  return <View style={styles.liveBadge}><Text style={styles.liveBadgeText}>实况</Text></View>;
}

// 全屏查看器里的实况照片页：默认静帧，点按提取内嵌视频并播放。
// 静帧始终垫底：视频出首帧才盖上来（消除开始时的闪黑），播完自动回到静帧、可再次点按重播
function LivePhotoPage({ entry, active, onZoomChange }) {
  const styles = useThemedStyles(makeStyles);
  const [info, setInfo] = useState(null);
  const [playingUri, setPlayingUri] = useState(null);
  const [videoReady, setVideoReady] = useState(false);
  const [loading, setLoading] = useState(false);
  // 进页面就预热好的动效地址：点播放直接命中，不用再等提取
  const preloadRef = useRef(null);
  useEffect(() => {
    let alive = true;
    setPlayingUri(null);
    setVideoReady(false);
    preloadRef.current = null;
    getLivePhotoInfo(entry, { full: true }).then(i => {
      if (!alive) return;
      setInfo(i);
      // 打开全屏查看器就开始提取（后台、串行）：通常你点「实况」之前就已经备好了
      if (i?.live) {
        extractMotionVideo(entry, i)
          .then(uri => { if (alive && uri) preloadRef.current = uri; })
          .catch(() => {});
      }
    });
    return () => { alive = false; };
  }, [entry]);
  const isLive = !!info?.live;
  const handlePlay = async () => {
    if (loading || playingUri) return;
    // 预热好了就是纯切换，不再有任何文件 IO
    if (preloadRef.current) { setVideoReady(false); setPlayingUri(preloadRef.current); return; }
    setLoading(true);
    try {
      const uri = await extractMotionVideo(entry, info);
      if (uri) { setVideoReady(false); setPlayingUri(uri); }
      else if (Platform.OS === 'android') {
        // 提取失败别静默：以前失败在这里被吞掉，用户只看到"点了没反应"
        ToastAndroid.show('实况动效读取失败，先看静帧吧（可在侧边栏「数据目录」查看）', ToastAndroid.LONG);
      }
    } finally {
      setLoading(false);
    }
  };
  /* 普通照片和实况照片的静帧都用同一个可缩放视图（双指捏合 / 双击放大 / 放大后拖动）。
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
              <PlayCircle size={16} color="#FFF" />
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

export default function DetailScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { logData, updateLog } = useContext(LogContext);

  // 通过 id 从全局数据里取，编辑/删除后页面能自动同步
  const itemId = route.params?.item?.id;
  const item = useMemo(
    () => logData.find(l => l.id === itemId),
    [logData, itemId]
  );

  const [viewerIndex, setViewerIndex] = useState(-1);
  const [currentViewIndex, setCurrentViewIndex] = useState(-1);
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

  // 封面：长按九宫格里任意一张设为/取消封面，记录在 coverIndex 上。
  // 设为封面时同步生成小图文件（covers/ 目录），列表/详情直接显示，重启无需重新解析相册
  const handleGridLongPress = (idx) => {
    const isCurrentCover = item.coverIndex === idx;
    Alert.alert('封面设置', '将这张影像设为该记录的封面吗？', [
      { text: '取消', style: 'cancel' },
      ...(item.coverIndex != null
        ? [{ text: '取消封面', style: 'destructive', onPress: () => updateLog({ ...item, coverIndex: null, coverThumbUrl: null }) }]
        : []),
      {
        text: isCurrentCover ? '重新设为封面' : '设为封面',
        onPress: async () => {
          let coverThumbUrl = null;
          try {
            const entry = normalizeMediaEntry(item.localImages?.[idx]);
            const resolved = await resolveMediaUri(entry);
            coverThumbUrl = await downscaleCover(resolved || entry?.uri);
          } catch {}
          updateLog({ ...item, coverIndex: idx, coverThumbUrl: coverThumbUrl || null });
        },
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

  return (
    <View style={styles.container}>
      <StatusBar style={viewerIndex >= 0 ? 'light' : (isDark ? 'light' : 'dark')} />

      {/* 顶部导航栏 */}
      <View style={[styles.navBar, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity style={styles.navBtn} onPress={() => navigation.goBack()}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.navTitle} numberOfLines={1}>{displayTitle}</Text>
        <View style={styles.navBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        scrollEnabled={!gridDragging}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <Animated.View entering={FadeInDown.duration(300)} style={styles.detailHeader}>
          {coverSource ? (
            <CoverIcon item={item} height={80} style={{ marginRight: 0 }} />
          ) : (
            <View style={[styles.iconBox, { backgroundColor: iconConfig.iconBgColor }]}>
              <iconConfig.IconComponent color={iconConfig.iconColor} size={26} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            {/* 标题独占一行，标签放到日期那一行：名字再长也不会把标签挤出去 */}
            <Text style={styles.detailTitle} numberOfLines={2}>{displayTitle}</Text>
            <View style={styles.detailMetaRow}>
              <Text style={styles.detailDate}>{item.date}</Text>
              <Text style={[styles.typeTag, { color: iconConfig.iconColor, backgroundColor: iconConfig.iconBgColor }]}>
                {labelOf(item)}
              </Text>
            </View>
          </View>
        </Animated.View>

        {(item.rating || item.mood || item.subtitle || item.comment) && (
          <Animated.View entering={FadeInDown.duration(300).delay(60)} style={styles.reviewBox}>
            {/* 随笔用心情 emoji + 天气顶替星级，其它类型保持原来的五星 */}
            {essay ? (
              <View style={styles.reviewRatingRow}>
                <Text style={styles.moodEmoji}>{item.mood}</Text>
                {!!item.weather && <Text style={styles.moodWeather}>天气 {item.weather}</Text>}
              </View>
            ) : (!!item.rating && (
              <View style={styles.reviewRatingRow}>
                {[1, 2, 3, 4, 5].map((i) => {
                  const isFull = i <= item.rating;
                  const isHalf = i === Math.ceil(item.rating) && !Number.isInteger(item.rating);
                  if (isHalf) return <StarHalf key={i} size={22} color={colors.star} fill={colors.star} style={{ marginRight: 3 }} />;
                  return <Star key={i} size={22} color={isFull ? colors.star : colors.starEmpty} fill={isFull ? colors.star : "transparent"} style={{ marginRight: 3 }} />;
                })}
                <Text style={styles.reviewScore}>{item.rating} 分</Text>
              </View>
            ))}
            {!!item.subtitle && <Text style={styles.reviewText}>{item.subtitle}</Text>}
            {/* 旅票的 subtitle 是车次/航班号，评论存在独立字段里 */}
            {!!item.comment && <Text style={styles.reviewText}>{item.comment}</Text>}
          </Animated.View>
        )}

        {/* 相关影像九宫格 */}
        {resolvedMedia.length > 0 && (
          <Animated.View entering={FadeInDown.duration(300).delay(120)} style={{ marginTop: 16 }}>
            <Text style={styles.sectionTitle}>相关影像</Text>
            <MediaGrid
              entries={resolvedMedia}
              coverIndex={item.coverIndex}
              onOpen={(idx) => { setViewerIndex(idx); setCurrentViewIndex(idx); }}
              onIdleLongPress={handleGridLongPress}
              onReorder={handleMediaReorder}
              onDragChange={setGridDragging}
            />
          </Animated.View>
        )}
      </ScrollView>

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
          <TouchableOpacity style={[styles.viewerCloseBtn, { top: insets.top + 10 }]} onPress={() => { setViewerIndex(-1); setCurrentViewIndex(-1); setViewerZoomed(false); }}>
            <X size={28} color="#FFF" />
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
  navBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: c.bg, paddingHorizontal: 12, paddingBottom: 8
  },
  navBtn: { width: 36, alignItems: 'center' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: c.text, marginHorizontal: 4 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bgElevated, borderRadius: 14, padding: 14, gap: 12 },
  iconBox: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  detailMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' },
  detailTitle: { fontSize: 19, fontWeight: '700', color: c.text },
  typeTag: { fontSize: 10.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden', flexShrink: 0 },
  detailDate: { fontSize: 13, color: c.textMuted },
  reviewBox: { backgroundColor: c.bgElevated, borderRadius: 12, padding: 16, marginTop: 12 },
  reviewRatingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  reviewScore: { marginLeft: 10, fontSize: 16, fontWeight: '700', color: c.star },
  moodEmoji: { fontSize: 26, lineHeight: 32, marginRight: 8 },
  moodWeather: { fontSize: 14, color: c.textSecondary },
  reviewText: { fontSize: 16, color: c.text, lineHeight: 24 },
  coverBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  coverBadgeText: { color: '#FFF', fontSize: 10 },
  liveBadge: { position: 'absolute', left: 8, top: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  liveBadgeText: { color: '#FFF', fontSize: 10 },
  livePlayBadge: { position: 'absolute', right: 16, bottom: 16, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  livePlayText: { color: '#FFF', fontSize: 12, marginRight: 5 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: c.text },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginTop: 8 },
  gridItem: { width: '33.33%', padding: 4 },
  gridImage: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: c.mediaPlaceholder },
  videoThumbnailBox: { width: '100%', aspectRatio: 1, borderRadius: 10, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: c.mediaPlaceholder },
  playOverlay: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  viewerContainer: { flex: 1, backgroundColor: '#000' },
  viewerCloseBtn: { position: 'absolute', zIndex: 10, right: 16 },
});
