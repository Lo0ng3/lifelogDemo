import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, interpolate, interpolateColor,
  Extrapolation, runOnJS, useAnimatedScrollHandler,
} from 'react-native-reanimated';

import RecordRow from './RecordRow';
import PressableScale from './PressableScale';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { groupColor } from '../utils/recordMeta';

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const MAX_DOTS = 3;
/* 周条（星期表头 / 收起后的本周）和日期格必须用同一组左右边界：
   日期格住在 tlWrap 里（tlWrap 有 marginHorizontal: TL_PAD_H），grid 再叠一层
   paddingHorizontal: GRID_PAD_H，所以最外侧那一天距容器边 = TL_PAD_H + GRID_PAD_H；
   而周条是 tlWrap 外面的兄弟节点，得自己补上同样的缩进。
   之前周条只写了 10，日期格实际内缩 16+10，两者差 16px —— 星期文字相对日期
   会整体"扇形"错开（第一列偏左、最后一列偏右），就是看到的没对齐。 */
const TL_PAD_H = 16;
const GRID_PAD_H = 10;
// 没有记录的日期共用同一个空数组：否则每次渲染都是新的 []，
// 会让下面的 memo 化日期格全部判定为"props 变了"而重渲染
const NO_RECORDS = [];

const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const todayKey = () => {
  const d = new Date();
  return dateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

/* 单个日期格：选中底色 / 今天描边都用动画过渡，点按有轻微缩放。
   memo + 「按格子位置而不是日期做 key」两层一起用：换月时 42 个格子是
   更新而不是重建（不会重挂 Animated 值 / 手势 / 共享值），只点某天时
   也只有选中状态真正变了的两个格子重渲染。 */
const DayCell = React.memo(function DayCell({ cell, records, selected, isToday, onPress, colors, styles, compact }) {
  const on = useSharedValue(selected ? 1 : 0);
  useEffect(() => { on.value = withTiming(selected ? 1 : 0, { duration: 160 }); }, [selected, on]);
  const bg = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(on.value, [0, 1], ['rgba(0,0,0,0)', colors.accentSoft]),
  }));
  const dots = records.slice(0, MAX_DOTS);
  const more = records.length - dots.length;

  return (
    <PressableScale containerStyle={styles.dayHit} style={styles.dayFill} activeScale={0.9} onPress={() => onPress(cell.date)}>
      <Reanimated.View style={[styles.day, compact && styles.dayCompact, cell.out && styles.dayOut, bg]}>
        {isToday && <View style={[styles.todayRing, compact && styles.todayRingCompact]} pointerEvents="none" />}
        <Text style={[styles.dayNum, compact && styles.dayNumCompact, cell.out && styles.dayNumOut, isToday && styles.dayNumToday]}>{cell.day}</Text>
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
});

/* ------------------------------------------------------------------ *
 * 月示图：上半是日历（圆点按一级类型着色），下半是当月 / 当日时间线。
 * 左右滑动日历换月；点日期只看当天，再点一次回到整月。
 * ------------------------------------------------------------------ */
export default function MonthView({ records, onPressItem, onEditItem, onDeleteItem }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const now = new Date();
  const today = todayKey();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const [selected, setSelected] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(now.getFullYear());
  const shift = useSharedValue(0);
  const listRef = useRef(null);
  // 折叠日历：完整月历随列表上滑滚走，收起后顶部固定显示"本周 7 天"，随时还能点某天
  const [collapsed, setCollapsed] = useState(false);
  const headerHSV = useSharedValue(0);
  const collapsedFlag = useSharedValue(0);
  const onListScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      const y = e.contentOffset.y;
      const should = y > Math.max(0, headerHSV.value - 76) ? 1 : 0;
      if (should !== collapsedFlag.value) {
        collapsedFlag.value = should;
        runOnJS(setCollapsed)(should === 1);
      }
    },
  });

  const byDate = useMemo(() => {
    const map = new Map();
    records.forEach((r) => {
      const key = String(r.date).slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    return map;
  }, [records]);

  // 点日期：只有那天有记录才切换选中（点日历格还会把列表滚回顶部展开日历）
  // 回调保持稳定 + 用 ref 读最新的 byDate，memo 化的日期格才不会因为父级重渲染而集体失效
  const byDateRef = useRef(byDate);
  byDateRef.current = byDate;
  const selectDay = useCallback((date, scrollTop) => {
    if ((byDateRef.current.get(date) || NO_RECORDS).length === 0) return;
    setSelected((prev) => (prev === date ? null : date));
    if (scrollTop) listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);
  const pressDayInGrid = useCallback((date) => selectDay(date, true), [selectDay]);
  const pressDayInStrip = useCallback((date) => selectDay(date, false), [selectDay]);

  // 按月预分组：切月时 O(1) 取当月记录，不用每次遍历全部记录（记录多时切月会明显卡顿）
  const byMonth = useMemo(() => {
    const map = new Map();
    records.forEach((r) => {
      const key = String(r.date).slice(0, 7);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    map.forEach((list) => list.sort((a, b) => String(a.date).localeCompare(String(b.date))));
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
    const list = selected
      ? (byDate.get(selected) || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
      : (byMonth.get(`${cursor.y}-${pad(cursor.m)}`) || []);

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
  }, [byDate, byMonth, cursor, selected]);

  const goMonth = useCallback((delta) => {
    setCursor((prev) => {
      let m = prev.m + delta;
      let y = prev.y;
      if (m === 0) { m = 12; y -= 1; }
      if (m === 13) { m = 1; y += 1; }
      return { y, m };
    });
    setSelected(null);
    // 先起动画再改 state：这样弹簧在 UI 线程先跑起来，后面的重排不会拖住它
    shift.value = delta * 26;
    shift.value = withSpring(0, { damping: 20, stiffness: 190, mass: 0.7 });
  }, [shift]);

  const goToday = useCallback(() => {
    const d = new Date();
    setCursor({ y: d.getFullYear(), m: d.getMonth() + 1 });
    setSelected(todayKey());
    shift.value = 0;
  }, [shift]);

  // 日历按整行切 7 个：用 flex 均分，不用百分比——百分比在部分机型上会四舍五入导致第 7 列换行堆叠
  const weeks = useMemo(() => {
    const out = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [cells]);

  // 收起后显示的那一周：优先选中的日期，其次今天（若在当前月），否则本月 1 号
  const anchorWeek = useMemo(() => {
    const monthPrefix = `${cursor.y}-${pad(cursor.m)}`;
    const anchor = selected || (todayKey().startsWith(monthPrefix) ? todayKey() : `${monthPrefix}-01`);
    const d = new Date(`${anchor}T00:00:00`);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => {
      const x = new Date(monday);
      x.setDate(monday.getDate() + i);
      return {
        date: dateKey(x.getFullYear(), x.getMonth() + 1, x.getDate()),
        day: x.getDate(),
        out: `${x.getFullYear()}-${pad(x.getMonth() + 1)}` !== monthPrefix,
      };
    });
  }, [cursor.y, cursor.m, selected]);

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

  const renderRow = useCallback(({ item: row, index }) => {
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
        onDelete={onDeleteItem}
      />
    );
  }, [onPressItem, onEditItem, onDeleteItem, timeline, styles]);

  return (
    <View style={styles.container}>
      {/* 年月条固定在顶部，永远看得到 */}
      <View style={styles.monthBar}>
        {/* 点年月可以跳到任意年月（不带日） */}
        <TouchableOpacity
          style={styles.monthLabelBtn}
          onPress={() => { setPickerYear(cursor.y); setPickerOpen(v => !v); }}
          activeOpacity={0.7}
        >
          <Text style={styles.monthLabel}>{`${cursor.y}年${cursor.m}月`}</Text>
          <Text style={[styles.monthLabelChevron, pickerOpen && styles.monthLabelChevronUp]}>⌄</Text>
        </TouchableOpacity>
        <View style={styles.nav}>
          <TouchableOpacity style={styles.navBtn} onPress={() => goMonth(-1)} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
            <Text style={styles.navBtnText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.navBtn} onPress={() => goMonth(1)} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
            <Text style={styles.navBtnText}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.todayBtn} onPress={() => { goToday(); listRef.current?.scrollToOffset({ offset: 0, animated: true }); }}>
            <Text style={styles.todayBtnText}>今天</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 固定的"周条"：展开时是星期表头，日历收起来后变成本周 7 天（照样能点某天） */}
      <View style={styles.weekStrip}>
        {collapsed ? (
          anchorWeek.map((cell, ci) => (
            <DayCell
              key={ci}
              cell={cell}
              compact
              records={byDate.get(cell.date) || NO_RECORDS}
              selected={selected === cell.date}
              isToday={cell.date === today}
              onPress={pressDayInStrip}
              colors={colors}
              styles={styles}
            />
          ))
        ) : (
          WEEK.map((w) => <Text key={w} style={styles.weekText}>{w}</Text>)
        )}
      </View>

      {/* 日历跟列表在同一个滚动容器里：上滑就把日历顶上去，记录多时列表能占满整屏 */}
      <View style={styles.tlWrap}>
        <Reanimated.FlatList
          ref={listRef}
          data={timeline}
          keyExtractor={(row) => row.id}
          renderItem={renderRow}
          onScroll={onListScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          bounces={false}
          overScrollMode="never"
          // 同首页列表：收窄虚拟化窗口、Android 裁掉屏外行，切换日历/滑动更稳
          initialNumToRender={6}
          maxToRenderPerBatch={4}
          windowSize={5}
          updateCellsBatchingPeriod={24}
          removeClippedSubviews={Platform.OS === 'android'}
          ListEmptyComponent={<Text style={styles.empty}>{selected ? '这一天没有记录' : '这个月还没有记录'}</Text>}
          contentContainerStyle={styles.tlContent}
          ListHeaderComponent={(
            <GestureDetector gesture={swipeMonth}>
              <Reanimated.View
                style={gridStyle}
                onLayout={(e) => { headerHSV.value = e.nativeEvent.layout.height; }}
              >
                {pickerOpen ? (
                  <View style={styles.picker}>
                    <View style={styles.pickerYearRow}>
                      <TouchableOpacity style={styles.navBtn} onPress={() => setPickerYear(v => v - 1)}>
                        <Text style={styles.navBtnText}>‹</Text>
                      </TouchableOpacity>
                      <Text style={styles.pickerYear}>{pickerYear}年</Text>
                      <TouchableOpacity style={styles.navBtn} onPress={() => setPickerYear(v => v + 1)}>
                        <Text style={styles.navBtnText}>›</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.pickerMonths}>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                        const on = cursor.y === pickerYear && cursor.m === m;
                        return (
                          <TouchableOpacity
                            key={m}
                            style={[styles.monthChip, on && styles.monthChipOn]}
                            onPress={() => {
                              setCursor({ y: pickerYear, m });
                              setSelected(null);
                              setPickerOpen(false);
                              shift.value = 0;
                            }}
                          >
                            <Text style={[styles.monthChipText, on && styles.monthChipTextOn]}>{m}月</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                ) : (
                  <>
                    <View style={styles.grid}>
                      {weeks.map((week, wi) => (
                        <View key={wi} style={styles.week}>
                          {week.map((cell, ci) => (
                            <DayCell
                              key={wi * 7 + ci}
                              cell={cell}
                              records={cell.out ? NO_RECORDS : (byDate.get(cell.date) || NO_RECORDS)}
                              selected={selected === cell.date}
                              isToday={cell.date === today}
                              onPress={pressDayInGrid}
                              colors={colors}
                              styles={styles}
                            />
                          ))}
                        </View>
                      ))}
                    </View>
                  </>
                )}
                <View style={styles.tlHead}>
                  <Text style={styles.tlTitle}>
                    {selected
                      ? `${Number(selected.slice(5, 7))}月${Number(selected.slice(8, 10))}日`
                      : `${cursor.m}月 · 全部`}
                  </Text>
                  <Text style={styles.tlCount}>{timeline.length ? `${timeline.filter((r) => r.kind === 'item').length} 条` : ''}</Text>
                </View>
              </Reanimated.View>
            </GestureDetector>
          )}
        />
      </View>
    </View>
  );
}

const makeStyles = (c) => ({
  container: { flex: 1 },
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 6 },
  monthLabelBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingRight: 6 },
  monthLabel: { fontSize: 16, fontWeight: '600', color: c.text },
  monthLabelChevron: { fontSize: 13, color: c.textMuted, marginLeft: 5, marginTop: -3 },
  monthLabelChevronUp: { transform: [{ rotate: '180deg' }], marginTop: 3 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navBtn: { width: 30, height: 30, borderRadius: 10, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center' },
  navBtnText: { fontSize: 16, color: c.textSecondary, marginTop: -2 },
  todayBtn: { height: 30, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' },
  todayBtnText: { fontSize: 12.5, color: c.accent, fontWeight: '600' },
  // 收起时固定显示的那条"本周"；左右缩进要跟日期格一致（见 TL_PAD_H / GRID_PAD_H 的说明）
  weekStrip: { flexDirection: 'row', alignItems: 'center', height: 38, paddingHorizontal: TL_PAD_H + GRID_PAD_H, marginBottom: 4 },
  weekText: { flex: 1, textAlign: 'center', fontSize: 11, color: c.textMuted },
  grid: { paddingHorizontal: GRID_PAD_H, paddingBottom: 6 },
  week: { flexDirection: 'row' },
  dayHit: { flex: 1, paddingVertical: 2 },
  dayFill: { width: '100%' },
  day: { height: 44, borderRadius: 12, alignItems: 'center', paddingTop: 5 },
  dayCompact: { height: 34, paddingTop: 2 },
  dayOut: {},
  todayRing: { position: 'absolute', top: 2, left: 2, right: 2, bottom: 2, borderRadius: 11, borderWidth: 1, borderColor: c.accentSoftBorder },
  todayRingCompact: { top: 0, left: 0, right: 0, bottom: 0, borderRadius: 10 },
  dayNum: { fontSize: 13, color: c.text, lineHeight: 16 },
  dayNumCompact: { fontSize: 12, lineHeight: 15 },
  dayNumOut: { color: c.textFaint },
  dayNumToday: { color: c.accent, fontWeight: '700' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 2.5, marginTop: 4 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  more: { fontSize: 8.5, color: c.textMuted, marginLeft: 1 },

  // 年月选择：只到月，不选日
  picker: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 12 },
  pickerYearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 10 },
  pickerYear: { fontSize: 15, fontWeight: '600', color: c.text, minWidth: 72, textAlign: 'center' },
  pickerMonths: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  monthChip: { width: 66, paddingVertical: 9, borderRadius: 12, backgroundColor: c.bgSunken, borderWidth: 1,
    borderColor: c.border, alignItems: 'center' },
  monthChipOn: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  monthChipText: { fontSize: 13, color: c.textSecondary },
  monthChipTextOn: { color: c.accent, fontWeight: '600' },

  tlHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6, borderTopWidth: 1, borderTopColor: c.divider },
  tlTitle: { fontSize: 13.5, fontWeight: '600', color: c.text },
  tlCount: { fontSize: 11.5, color: c.textMuted },
  tlWrap: { flex: 1, marginHorizontal: TL_PAD_H, backgroundColor: c.bgElevated, borderRadius: 14, overflow: 'hidden' },
  tlContent: { paddingBottom: 0 },
  dayGroup: { fontSize: 11.5, color: c.textMuted, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 },
  empty: { textAlign: 'center', color: c.textMuted, fontSize: 13, paddingVertical: 40 },
});
