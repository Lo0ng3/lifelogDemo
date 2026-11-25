import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import { ChevronLeft } from 'lucide-react-native';
import { wgs84ToGcj02 } from '../utils/coord';
import { hapticSelection } from '../utils/haptics';
import NativeIcon from './NativeIcon';
import LiquidGlassSurface from './LiquidGlassSurface';

let NativeAppleMapView = null;
if (Platform.OS === 'ios') {
  try {
    NativeAppleMapView = requireNativeViewManager('Paths', 'NativeAppleMapView');
  } catch {
    NativeAppleMapView = null;
  }
}

export const hasNativeAppleMap = Platform.OS === 'ios' && !!NativeAppleMapView;

const TYPE_COLORS = { flight: '#2F7BF6', train: '#10B981', bus: '#F97316', ship: '#8B5CF6' };
const LOCATION_COLOR = '#EE4D3D';
const TYPE_LABELS = { flight: '机票', train: '火车票', bus: '汽车票', ship: '轮船', location: '地点' };
const TRAJ_TYPES = ['flight', 'train', 'bus', 'ship'];
const NO_NAME_KEYS = { 未命名记录: 1, 未命名: 1 };
const DEFAULT_FILTER = { flight: true, train: true, bus: true, ship: true, location: true };

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const nameKeyOf = (s) => {
  const short = String(s == null ? '' : s).replace(/(国际机场|机场)$/, '').trim();
  const key = short.replace(/\s+/g, '').toLowerCase();
  return key && !NO_NAME_KEYS[key] ? key : '';
};

const groupColorOf = (records) => {
  for (let i = 0; i < records.length; i++) {
    if (records[i].kind === 'location') return LOCATION_COLOR;
  }
  return TYPE_COLORS[records[0]?.subType] || '#2F7BF6';
};

const buildBezierCoords = (from, to) => {
  const A = [from.longitude, from.latitude];
  const B = [to.longitude, to.latitude];
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const bend = Math.min(1.6, Math.max(0.12, len * 0.14));
  const C = [(A[0] + B[0]) / 2 + (dy / len) * bend, (A[1] + B[1]) / 2 - (dx / len) * bend];
  const coords = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    const u = 1 - t;
    coords.push([
      u * u * A[1] + 2 * u * t * C[1] + t * t * B[1],
      u * u * A[0] + 2 * u * t * C[0] + t * t * B[0],
    ]);
  }
  return coords;
};

export default function AppleMapView({
  points = [],
  segs = [],
  isDark = false,
  mapColors,
  mapFilter = DEFAULT_FILTER,
  fullscreen = false,
  safeLeft = 16,
  onExitFullscreen,
  onOpenDetail,
}) {
  const c = mapColors || {
    bg: isDark ? '#0B0D11' : '#F4F6F9',
    controlBg: isDark ? 'rgba(22,25,32,0.92)' : 'rgba(255,255,255,0.92)',
    controlText: isDark ? '#E5E9F2' : '#1A1D23',
    controlBorder: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(26,29,35,0.12)',
    cardBg: isDark ? '#161920' : '#FFFFFF',
    cardText: isDark ? '#F1F4F9' : '#1A1D23',
    cardMeta: isDark ? '#8F98A8' : '#7A8394',
    cardNote: isDark ? '#C5CCD9' : '#4A5260',
    dotBorder: isDark ? '#161920' : '#FFFFFF',
  };

  const locOn = mapFilter?.location !== false;
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });
  const [cardState, setCardState] = useState(null); // { groupId, index, x, y }
  const cmdSeqRef = useRef(0);
  const [commandJson, setCommandJson] = useState('');
  const didInitialFitRef = useRef(false);

  const sendCommand = useCallback((payload) => {
    cmdSeqRef.current += 1;
    setCommandJson(JSON.stringify({ seq: cmdSeqRef.current, ...payload }));
  }, []);

  // WGS-84 → GCJ-02（苹果地图中国大陆底图使用高德 GCJ-02，海外自动不偏）
  const { groups, cleanSegs } = useMemo(() => {
    const cleanPoints = [];
    for (const p of points) {
      const lat = toNum(p?.lat);
      const lng = toNum(p?.lng);
      if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      const shifted = wgs84ToGcj02(lat, lng);
      cleanPoints.push({ ...p, lat: shifted.lat, lng: shifted.lng });
    }

    const segsOut = [];
    for (const s of segs) {
      const fLat = toNum(s?.from?.latitude);
      const fLng = toNum(s?.from?.longitude);
      const tLat = toNum(s?.to?.latitude);
      const tLng = toNum(s?.to?.longitude);
      if (fLat == null || fLng == null || tLat == null || tLng == null) continue;
      const f = wgs84ToGcj02(fLat, fLng);
      const t = wgs84ToGcj02(tLat, tLng);
      segsOut.push({
        from: { name: s.from?.name || '', latitude: f.lat, longitude: f.lng },
        to: { name: s.to?.name || '', latitude: t.lat, longitude: t.lng },
        count: s.count || 1,
        subType: s.subType,
      });
    }

    const buckets = {};
    const rawGroups = [];
    for (const p of cleanPoints) {
      const key = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
      let g = buckets[key];
      if (!g) {
        g = { id: `g${rawGroups.length + 1}`, lat: p.lat, lng: p.lng, records: [] };
        buckets[key] = g;
        rawGroups.push(g);
      }
      g.records.push(p);
    }

    rawGroups.forEach((g) => {
      g.onLoc = g.records.some((r) => r.kind === 'location');
      const counts = {};
      let best = 0;
      g.nameKey = null;
      g.records.forEach((r) => {
        const k = nameKeyOf(r.title);
        if (!k) return;
        counts[k] = (counts[k] || 0) + 1;
        if (counts[k] > best) {
          best = counts[k];
          g.nameKey = k;
        }
      });
      g.color = groupColorOf(g.records);
    });

    const byName = {};
    const merged = [];
    rawGroups.forEach((g) => {
      const key = g.nameKey;
      if (!key) {
        merged.push(g);
        return;
      }
      const anchor = byName[key];
      if (!anchor) {
        byName[key] = g;
        merged.push(g);
        return;
      }
      if (g.records.length > anchor.records.length) {
        g.records = g.records.concat(anchor.records);
        g.onLoc = g.onLoc || anchor.onLoc;
        g.color = groupColorOf(g.records);
        const at = merged.indexOf(anchor);
        if (at >= 0) merged[at] = g;
        else merged.push(g);
        byName[key] = g;
      } else {
        anchor.records = anchor.records.concat(g.records);
        anchor.onLoc = anchor.onLoc || g.onLoc;
        anchor.color = groupColorOf(anchor.records);
      }
    });

    return { groups: merged, cleanSegs: segsOut };
  }, [points, segs]);

  const groupMap = useMemo(() => {
    const m = new Map();
    groups.forEach((g) => m.set(g.id, g));
    return m;
  }, [groups]);

  const trajAnyOn = useMemo(() => TRAJ_TYPES.some((t) => mapFilter?.[t] !== false), [mapFilter]);
  const trajTypeOn = useCallback((t) => !t || mapFilter?.[t] !== false, [mapFilter]);

  const { dataJson, visibleCoords } = useMemo(() => {
    const markers = [];
    const badges = [];
    const polylines = [];
    const allCoords = [];

    groups.forEach((g) => {
      const showLoc = g.onLoc && locOn;
      const showTraj = !g.onLoc && trajAnyOn && g.records.some((r) => trajTypeOn(r.subType));
      if (!showLoc && !showTraj) return;
      const z = (g.onLoc ? 400 : 100) + Math.min(80, g.records.length * 4);
      markers.push({ id: g.id, lat: g.lat, lng: g.lng, color: g.color, z });
      allCoords.push([g.lat, g.lng]);
    });

    if (trajAnyOn) {
      cleanSegs.forEach((seg, idx) => {
        if (!trajTypeOn(seg.subType)) return;
        const color = TYPE_COLORS[seg.subType] || '#007AFF';
        const coords = buildBezierCoords(seg.from, seg.to);
        polylines.push({
          id: `seg_${idx}`,
          coords,
          color,
          weight: Math.min(8, 3 + (seg.count - 1) * 1.6),
          opacity: 0.85,
        });
        allCoords.push([seg.from.latitude, seg.from.longitude], [seg.to.latitude, seg.to.longitude]);
        if (seg.count > 1) {
          const mid = coords[14] || coords[Math.floor(coords.length / 2)];
          if (mid) {
            badges.push({ id: `badge_${idx}`, lat: mid[0], lng: mid[1], count: seg.count, color });
          }
        }
      });
    }

    return {
      dataJson: JSON.stringify({
        markers,
        badges,
        polylines,
        dotBorder: c.dotBorder,
      }),
      visibleCoords: allCoords,
    };
  }, [groups, cleanSegs, locOn, trajAnyOn, trajTypeOn, c.dotBorder]);

  // 首次拿到可定位坐标后自动全览一次
  useEffect(() => {
    if (didInitialFitRef.current || visibleCoords.length === 0) return;
    didInitialFitRef.current = true;
    const t = setTimeout(() => {
      sendCommand({ type: 'fitAll', coords: visibleCoords, animated: false });
    }, 120);
    return () => clearTimeout(t);
  }, [visibleCoords, sendCommand]);

  const handlePinPress = useCallback((e) => {
    const { id, x, y, doubleTap } = e?.nativeEvent || {};
    if (!id || !groupMap.has(id)) return;
    setCardState((prev) => {
      if (!doubleTap && prev && prev.groupId === id) {
        sendCommand({ type: 'clearSelection' });
        return null;
      }
      return { groupId: id, index: 0, x: Number(x) || 0, y: Number(y) || 0 };
    });
  }, [groupMap, sendCommand]);

  const handleSelectedPinMove = useCallback((e) => {
    const { id, x, y } = e?.nativeEvent || {};
    if (!id) return;
    setCardState((prev) => {
      if (!prev || prev.groupId !== id) return prev;
      return { ...prev, x: Number(x) || 0, y: Number(y) || 0 };
    });
  }, []);

  const handleMapPress = useCallback(() => {
    setCardState(null);
  }, []);

  const activeGroup = cardState ? groupMap.get(cardState.groupId) : null;
  const activeRecords = activeGroup?.records || [];
  const activeIdx = activeRecords.length > 0 ? Math.min(cardState?.index || 0, activeRecords.length - 1) : 0;
  const activeRec = activeRecords[activeIdx] || null;

  const cardPosStyle = useMemo(() => {
    if (!cardState || !activeRec || !boxSize.w || !boxSize.h) return null;
    const cardW = 224;
    const estH = activeRec.note ? 132 : 96;
    const left = Math.max(10, Math.min(boxSize.w - cardW - 10, cardState.x - cardW / 2));
    const putBelow = cardState.y - estH - 36 < 10;
    const top = putBelow
      ? Math.min(boxSize.h - estH - 12, cardState.y + 14)
      : Math.max(10, cardState.y - estH - 34);
    return { left, top };
  }, [cardState, activeRec, boxSize.w, boxSize.h]);

  const anyData = groups.length > 0 || cleanSegs.length > 0;
  const locVisible = locOn && groups.some((g) => g.onLoc);
  const emptyHint = !anyData
    ? '当前没有可定位的印记'
    : (!locVisible && !trajAnyOn ? '当前筛选下没有可显示的标点与轨迹' : '');

  if (!NativeAppleMapView) return null;

  return (
    <View
      style={[styles.root, { backgroundColor: c.bg }]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setBoxSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
      }}
    >
      <NativeAppleMapView
        style={StyleSheet.absoluteFill}
        isDark={isDark}
        dataJson={dataJson}
        commandJson={commandJson}
        onPinPress={handlePinPress}
        onMapPress={handleMapPress}
        onSelectedPinMove={handleSelectedPinMove}
      />

      {/* 横屏全屏模式：左上角透明液态玻璃返回图标 */}
      {fullscreen && (
        <View style={[styles.fsBackWrap, { left: Math.max(16, safeLeft) }]}>
          <LiquidGlassSurface cornerRadius={19} isDark={isDark} interactive />
          <TouchableOpacity
            style={styles.fsBackBtn}
            activeOpacity={0.78}
            delayPressIn={0}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            onPress={() => {
              hapticSelection();
              onExitFullscreen?.();
            }}
          >
            <NativeIcon name="chevron.left" fallback={ChevronLeft} size={20} color={c.controlText} weight="semibold" />
          </TouchableOpacity>
        </View>
      )}

      {/* 空态提示 */}
      {!!emptyHint && (
        <View
          pointerEvents="none"
          style={[styles.hint, { backgroundColor: c.controlBg, borderColor: c.controlBorder }]}
        >
          <Text style={[styles.hintText, { color: c.cardMeta }]}>{emptyHint}</Text>
        </View>
      )}

      {/* 标点内容卡：跟随标点屏幕坐标，支持同地点左右翻页与查看详情 */}
      {activeRec && cardPosStyle && (
        <View
          style={[
            styles.rcCard,
            cardPosStyle,
            {
              backgroundColor: c.cardBg,
              shadowOpacity: isDark ? 0.55 : 0.24,
            },
          ]}
        >
          <View style={styles.rcRow}>
            <Text style={[styles.rcTitle, { color: c.cardText }]} numberOfLines={2}>
              {activeRec.title || '未命名'}
            </Text>
            <TouchableOpacity
              style={[styles.rcClose, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}
              onPress={() => {
                setCardState(null);
                sendCommand({ type: 'clearSelection' });
              }}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.rcCloseText, { color: c.cardMeta }]}>×</Text>
            </TouchableOpacity>
          </View>
          <Text style={[styles.rcMeta, { color: c.cardMeta }]} numberOfLines={1}>
            {[
              activeRec.kind === 'location'
                ? TYPE_LABELS.location
                : (TYPE_LABELS[activeRec.subType] || '旅票'),
              activeRec.date,
            ].filter(Boolean).join(' · ')}
          </Text>
          {!!activeRec.note && (
            <Text style={[styles.rcNote, { color: c.cardNote }]} numberOfLines={3}>
              {activeRec.note}
            </Text>
          )}
          <View style={styles.rcFooter}>
            {activeRecords.length > 1 && (
              <>
                <TouchableOpacity
                  style={[styles.rcPg, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}
                  onPress={() => setCardState((prev) => prev && ({
                    ...prev,
                    index: (activeIdx - 1 + activeRecords.length) % activeRecords.length,
                  }))}
                >
                  <Text style={[styles.rcPgText, { color: c.cardText }]}>‹</Text>
                </TouchableOpacity>
                <Text style={[styles.rcPi, { color: c.cardMeta }]}>
                  {activeIdx + 1}/{activeRecords.length}
                </Text>
                <TouchableOpacity
                  style={[styles.rcPg, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}
                  onPress={() => setCardState((prev) => prev && ({
                    ...prev,
                    index: (activeIdx + 1) % activeRecords.length,
                  }))}
                >
                  <Text style={[styles.rcPgText, { color: c.cardText }]}>›</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity
              style={styles.rcGo}
              onPress={() => onOpenDetail?.(activeRec.id)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.rcGoText, { color: isDark ? '#0A84FF' : '#007AFF' }]}>查看详情 →</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fsBackWrap: {
    position: 'absolute',
    top: 16,
    width: 38,
    height: 38,
    borderRadius: 19,
    overflow: Platform.OS === 'ios' ? 'visible' : 'hidden',
    zIndex: 20,
  },
  fsBackBtn: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    position: 'absolute',
    alignSelf: 'center',
    top: '44%',
    maxWidth: '78%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hintText: {
    fontSize: 12.5,
    lineHeight: 20,
    textAlign: 'center',
  },
  rcCard: {
    position: 'absolute',
    width: 224,
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 16,
  },
  rcRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  rcTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
  },
  rcClose: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rcCloseText: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 16,
  },
  rcMeta: {
    fontSize: 11.5,
    marginTop: 3,
  },
  rcNote: {
    fontSize: 12.5,
    marginTop: 6,
    lineHeight: 18,
  },
  rcFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  rcPg: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rcPgText: {
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 18,
  },
  rcPi: {
    minWidth: 30,
    textAlign: 'center',
    fontSize: 11.5,
    fontVariant: ['tabular-nums'],
  },
  rcGo: {
    marginLeft: 'auto',
  },
  rcGoText: {
    fontSize: 12.5,
    fontWeight: '600',
  },
});
