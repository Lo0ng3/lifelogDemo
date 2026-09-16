import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, interpolate, interpolateColor,
  Extrapolation, runOnJS,
} from 'react-native-reanimated';

import RecordRow from './RecordRow';
import PressableScale from './PressableScale';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { groupColor } from '../utils/recordMeta';

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const MAX_DOTS = 3;

const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const todayKey = () => {
  const d = new Date();
  return dateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

/* 单个日期格：选中底色 / 今天描边都用动画过渡，点按有轻微缩放 */
function DayCell({ cell, records, selected, isToday, onPress, colors, styles }) {
  const on = useSharedValue(selected ? 1 : 0);
  useEffect(() => { on.value = withTiming(selected ? 1 : 0, { duration: 160 }); }, [selected, on]);
  const bg = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(on.value, [0, 1], ['rgba(0,0,0,0)', colors.accentSoft]),
  }));
  const dots = records.slice(0, MAX_DOTS);
  const more = records.length - dots.length;

  return (
    <PressableScale style={styles.dayHit} activeScale={0.9} onPress={onPress}>
      <Reanimated.View style={[styles.day, cell.out && styles.dayOut, bg]}>
        {isToday && <View style={styles.todayRing} pointerEvents="none" />}
        <Text style={[styles.dayNum, cell.out && styles.dayNumOut, isToday && styles.dayNumToday]}>{cell.day}</Text>
        {records.length > 0 && (
          <View style={styles.dots}>
            {dots.map((r, i) => (
              <View key={i} style={[styles.dot, { backgroundColor: groupColor(r, colors) }]} />
            ))}
            {more > 0 && <Text style={styles.more}>+{more}</Text>}
          </View>
        )}
      </Reanimated.View>
    </PressableScale>
  );
}

/* ------------------------------------------------------------------ *
 * 月示图：上半是日历（圆点按一级类型着色），下半是当月 / 当日时间线。
 * 左右滑动日历换月；点日期只看当天，再点一次回到整月。
 * ------------------------------------------------------------------ */
export default function MonthView({ records, onPressItem, onEditItem }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const [selected, setSelected] = useState(null);
  const shift = useSharedValue(0);

  const byDate = useMemo(() => {
    const map = new Map();
    records.forEach((r) => {
      const key = String(r.date).slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    return map;
  }, [records]);

  const cells = useMemo(() => {
    const { y, m } = cursor;
    const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;   // 周一为第一天
    const daysInMonth = new Date(y, m, 0).getDate();
    const prevDays = new Date(y, m - 1, 0).getDate();
    const out = [];
    for (let i = 0; i < 42; i++) {
      let day; let cy = y; let cm = m; let isOut = false;
      if (i < offset) {
        day = prevDays - offset + 1 + i; cm = m - 1; isOut = true;
        if (cm === 0) { cm = 12; cy = y - 1; }
      } else if (i - offset + 1 > daysInMonth) {
        day = i - offset + 1 - daysInMonth; cm = m + 1; isOut = true;
        if (cm === 13) { cm = 1; cy = y + 1; }
      } else {
        day = i - offset + 1;
      }
      out.push({ date: dateKey(cy, cm, day), day, out: isOut });
    }
    // 最后一行整行都是下个月时省掉，5 行的月份更紧凑
    while (out.length > 35 && out.slice(out.length - 7).every((c) => c.out)) out.length -= 7;
    return out;
  }, [cursor]);

  // 当月（或选中日）的记录，按日期升序
  const timeline = useMemo(() => {
    const { y, m } = cursor;
    const list = records.filter((r) => {
      const d = String(r.date).slice(0, 10);
      if (selected) return d === selected;
      const [ry, rm] = d.split('-');
      return Number(ry) === y && Number(rm) === m;
    });
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // 拍平成 FlatList 的条目：日期分组标题 + 记录行
    const rows = [];
    let lastDate = null;
    list.forEach((item) => {
      const d = String(item.date).slice(0, 10);
      if (d !== lastDate) {
        rows.push({ kind: 'day', id: `d-${d}`, date: d });
        lastDate = d;
      }
      rows.push({ kind: 'item', id: `i-${item.id}`, item });
    });
    return rows;
  }, [records, cursor, selected]);

  const goMonth = useCallback((delta) => {
    setCursor((prev) => {
      let m = prev.m + delta;
      let y = prev.y;
      if (m === 0) { m = 12; y -= 1; }
      if (m === 13) { m = 1; y += 1; }
      return { y, m };
    });
    setSelected(null);
    shift.value = delta * 26;
    shift.value = withSpring(0, { damping: 20, stiffness: 190, mass: 0.7 });
  }, [shift]);

  const goToday = useCallback(() => {
    const d = new Date();
    setCursor({ y: d.getFullYear(), m: d.getMonth() + 1 });
    setSelected(todayKey());
    shift.value = 0;
  }, [shift]);

  // 日历区左右滑动换月（纵向手势留给下面的列表滚动）
  const swipeMonth = useMemo(() => Gesture.Pan()
    .activeOffsetX([-14, 14])
    .failOffsetY([-12, 12])
    .onEnd((e) => {
      if (e.translationX < -48) runOnJS(goMonth)(1);
      else if (e.translationX > 48) runOnJS(goMonth)(-1);
    }), [goMonth]);

  const gridStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shift.value }],
    opacity: interpolate(Math.abs(shift.value), [0, 26], [1, 0.45], Extrapolation.CLAMP),
  }));

  const renderRow = ({ item: row, index }) => {
    if (row.kind === 'day') {
      const [y, m, d] = row.date.split('-');
      const wd = WEEK[(new Date(Number(y), Number(m) - 1, Number(d)).getDay() + 6) % 7];
      return <Text style={styles.dayGroup}>{`${Number(m)}月${Number(d)}日 周${wd}`}</Text>;
    }
    // 组内最后一条不加分隔线，跟随原来列表的观感
    const next = timeline[index + 1];
    const isLast = !next || next.kind === 'day';
    return (
      <RecordRow
        item={row.item}
        isLast={isLast}
        onPress={onPressItem}
        onEdit={onEditItem}
      />
    );
  };

  return (
    <View style={styles.container}>
      <GestureDetector gesture={swipeMonth}>
        <Reanimated.View style={gridStyle}>
          <View style={styles.monthBar}>
            <Text style={styles.monthLabel}>{`${cursor.y}年${cursor.m}月`}</Text>
            <View style={styles.nav}>
              <TouchableOpacity style={styles.navBtn} onPress={() => goMonth(-1)} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
                <Text style={styles.navBtnText}>‹</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.navBtn} onPress={() => goMonth(1)} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
                <Text style={styles.navBtnText}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.todayBtn} onPress={goToday}>
                <Text style={styles.todayBtnText}>今天</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.weekRow}>
            {WEEK.map((w) => <Text key={w} style={styles.weekText}>{w}</Text>)}
          </View>
          <View style={styles.grid}>
            {cells.map((cell) => (
              <DayCell
                key={cell.date}
                cell={cell}
                records={cell.out ? [] : (byDate.get(cell.date) || [])}
                selected={selected === cell.date}
                isToday={cell.date === todayKey()}
                onPress={() => {
                  if ((byDate.get(cell.date) || []).length === 0) return;
                  setSelected((prev) => (prev === cell.date ? null : cell.date));
                }}
                colors={colors}
                styles={styles}
              />
            ))}
          </View>
        </Reanimated.View>
      </GestureDetector>

      <View style={styles.tlHead}>
        <Text style={styles.tlTitle}>
          {selected
            ? `${Number(selected.slice(5, 7))}月${Number(selected.slice(8, 10))}日`
            : `${cursor.m}月 · 全部`}
        </Text>
        <Text style={styles.tlCount}>{timeline.length ? `${timeline.filter((r) => r.kind === 'item').length} 条` : ''}</Text>
      </View>

      <View style={styles.tlWrap}>
        <FlatList
          data={timeline}
          keyExtractor={(row) => row.id}
          renderItem={renderRow}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={<Text style={styles.empty}>{selected ? '这一天没有记录' : '这个月还没有记录'}</Text>}
          contentContainerStyle={styles.tlContent}
        />
      </View>
    </View>
  );
}

const makeStyles = (c) => ({
  container: { flex: 1 },
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 6 },
  monthLabel: { fontSize: 16, fontWeight: '600', color: c.text },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navBtn: { width: 30, height: 30, borderRadius: 10, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center' },
  navBtnText: { fontSize: 16, color: c.textSecondary, marginTop: -2 },
  todayBtn: { height: 30, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' },
  todayBtnText: { fontSize: 12.5, color: c.accent, fontWeight: '600' },
  weekRow: { flexDirection: 'row', paddingHorizontal: 10, marginTop: 4 },
  weekText: { flex: 1, textAlign: 'center', fontSize: 11, color: c.textMuted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 10, paddingBottom: 6 },
  dayHit: { width: `${100 / 7}%`, paddingVertical: 2 },
  day: { height: 46, borderRadius: 12, alignItems: 'center', paddingTop: 5 },
  dayOut: {},
  todayRing: { position: 'absolute', top: 2, left: 2, right: 2, bottom: 2, borderRadius: 11, borderWidth: 1, borderColor: c.accentSoftBorder },
  dayNum: { fontSize: 13, color: c.text, lineHeight: 16 },
  dayNumOut: { color: c.textFaint },
  dayNumToday: { color: c.accent, fontWeight: '700' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 2.5, marginTop: 4 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  more: { fontSize: 8.5, color: c.textMuted, marginLeft: 1 },

  tlHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6, borderTopWidth: 1, borderTopColor: c.divider },
  tlTitle: { fontSize: 13.5, fontWeight: '600', color: c.text },
  tlCount: { fontSize: 11.5, color: c.textMuted },
  tlWrap: { flex: 1, marginHorizontal: 16, backgroundColor: c.bgElevated, borderRadius: 14, overflow: 'hidden' },
  tlContent: { paddingBottom: 12 },
  dayGroup: { fontSize: 11.5, color: c.textMuted, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 },
  empty: { textAlign: 'center', color: c.textMuted, fontSize: 13, paddingVertical: 40 },
});
