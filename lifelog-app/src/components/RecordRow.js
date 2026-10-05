import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { StarHalf, Edit3, Trash2 } from 'lucide-react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Reanimated, { useAnimatedStyle, interpolate, Extrapolation } from 'react-native-reanimated';

import CoverIcon from './CoverIcon';
import PressableScale from './PressableScale';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { labelOf, groupColor, groupSoft, isEssay, starsOf } from '../utils/recordMeta';
import { shortTicketTitle } from '../utils/format';

// 震动反馈：模块缺失（旧构建）时静默跳过，不影响功能
let Haptics = null;
try { Haptics = require('expo-haptics'); } catch {}
const lightTap = () => { try { Haptics?.impactAsync?.(Haptics.ImpactFeedbackStyle.Light); } catch {} };

// 右滑操作区：固定宽度保证滑动距离可测
const ACTIONS_WIDTH = 148;
const BTN_WIDTH = 74;

/* 星级：整星 / 空星直接用字形画，一个 Text 就画完 5 颗——
   原来 5 个 lucide 图标 = 5 个 Svg + 5 个 Path = 10 个原生 View，是每行最占地方的一块。
   只有 x.5 分那颗半星（少数）才用 SVG 精确画，外观和以前一致。 */
function renderStars(stars, colors, styles) {
  if (!stars) return null;
  const { full, half } = stars;
  if (half) {
    return (
      <View style={styles.starContainer}>
        {[1, 2, 3, 4, 5].map((i) => (
          i === full + 1
            ? <StarHalf key={i} size={12} color={colors.star} fill={colors.star} style={styles.starIcon} />
            : <Text key={i} style={[styles.starGlyph, { color: i <= full ? colors.star : colors.starEmpty }]}>{i <= full ? '★' : '☆'}</Text>
        ))}
      </View>
    );
  }
  const empty = 5 - full;
  return (
    <Text style={styles.starGlyph} numberOfLines={1}>
      {full > 0 && <Text style={{ color: colors.star }}>{'★'.repeat(full)}</Text>}
      {empty > 0 && <Text style={{ color: colors.starEmpty }}>{'☆'.repeat(empty)}</Text>}
    </Text>
  );
}

/* ------------------------------------------------------------------ *
 * 展开动画：操作区整体跟着手指走，两个按钮各自再做一次「错位弹入」
 * ——按下时只是滑动，松手落位时轻微回弹，避免以前的生硬平移。
 * ------------------------------------------------------------------ */
function SwipeActions({ drag, onEdit, onDelete }) {
  const styles = useThemedStyles(makeStyles);

  const containerStyle = useAnimatedStyle(() => {
    const t = interpolate(drag.value, [-ACTIONS_WIDTH, 0], [1, 0], Extrapolation.CLAMP);
    return {
      transform: [{ translateX: drag.value + ACTIONS_WIDTH }],
      opacity: 0.35 + 0.65 * t,
    };
  });
  // 修改按钮先亮、删除按钮晚一点跟上，形成轻微的层次感
  const editStyle = useAnimatedStyle(() => {
    const t = interpolate(drag.value, [-ACTIONS_WIDTH * 0.55, 0], [1, 0], Extrapolation.CLAMP);
    return { transform: [{ scale: 0.82 + 0.18 * t }], opacity: 0.2 + 0.8 * t };
  });
  const delStyle = useAnimatedStyle(() => {
    const t = interpolate(drag.value, [-ACTIONS_WIDTH * 0.9, -ACTIONS_WIDTH * 0.3, 0], [1, 0.9, 0], Extrapolation.CLAMP);
    return { transform: [{ scale: 0.78 + 0.22 * t }], opacity: t };
  });

  return (
    <Reanimated.View style={[styles.swipeActions, containerStyle]}>
      <Reanimated.View style={[styles.swipeBtnWrap, editStyle]}>
        <TouchableOpacity style={[styles.swipeBtn, styles.swipeEditBtn]} onPress={onEdit} activeOpacity={0.85}>
          <Edit3 size={18} color="#FFF" />
          <Text style={styles.swipeBtnText}>修改</Text>
        </TouchableOpacity>
      </Reanimated.View>
      <Reanimated.View style={[styles.swipeBtnWrap, delStyle]}>
        <TouchableOpacity style={[styles.swipeBtn, styles.swipeDeleteBtn]} onPress={onDelete} activeOpacity={0.85}>
          <Trash2 size={18} color="#FFF" />
          <Text style={styles.swipeBtnText}>删除</Text>
        </TouchableOpacity>
      </Reanimated.View>
    </Reanimated.View>
  );
}

/* ------------------------------------------------------------------ *
 * 列表 / 月示图共用的记录行
 * 版式沿用原来的列表行（封面 + 标题 + 日期 + 星级 + 摘要），只多了
 * 一个统一的类型标签；随笔类把星级那一行换成心情 emoji + 天气。
 * ------------------------------------------------------------------ */
const RecordRow = React.memo(function RecordRow({ item, isLast, onPress, onEdit, onDelete, style }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();

  const stars = starsOf(item.rating);
  const essay = isEssay(item);
  // 右滑操作区默认不挂：每行省下两个按钮 + 两个图标 + 三个动画 ≈ 14 个原生 View。
  // 手指一碰到这一行（onPressIn，早于右滑手势 activate 几十毫秒）就补上，
  // 所以第一次右滑照样跟手——Swipeable 是在手势 activate 时才量操作区宽度的。
  const [actionsReady, setActionsReady] = useState(false);
  const armActions = useCallback(() => setActionsReady(true), []);
  // 日期分两行：上面年份、下面 月-日（缺年份的历史记录就按原样显示）。
  // 时分只在旅票里有意义，放到详情页看；正文一行，保证每行高度完全一致
  const dateText = String(item.date || '');
  const yearLabel = dateText.slice(0, 4);
  const dayLabel = dateText.slice(5, 10);
  const textLine = [item.subtitle, item.comment].filter(Boolean).join(' · ');

  const confirmDelete = useCallback(() => Alert.alert(
    '删除印记',
    `确定要删除「${item.title}」吗？删除后无法恢复。`,
    [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => onDelete?.(item.id) },
    ]
  ), [item.id, item.title, onDelete]);

  // 用 useCallback 稳住引用：SwipeActions 里是三个 useAnimatedStyle，
  // 每次无关重渲染都重建一遍纯属白花
  const renderRightActions = useCallback((_progress, drag, swipeable) => (
    <SwipeActions
      drag={drag}
      onEdit={() => { swipeable.close(); onEdit?.(item); }}
      onDelete={() => {
        swipeable.close();
        // 关闭动画走完再弹确认，避免两套动画打架
        setTimeout(confirmDelete, 120);
      }}
    />
  ), [confirmDelete, item, onEdit]);

  return (
    <ReanimatedSwipeable
      renderRightActions={actionsReady ? renderRightActions : undefined}
      overshootRight={false}
      friction={1.7}
      rightThreshold={36}
      onSwipeableWillOpen={lightTap}
      containerStyle={[styles.swipeContainer, style]}
    >
      <PressableScale style={styles.cardRow} onPress={() => onPress?.(item)} onPressIn={armActions}>
        <View style={[styles.cardItem, !isLast && styles.cardItemBorder]}>
          <CoverIcon item={item} height={64} />
          <View style={styles.itemContent}>
            <View style={styles.itemHeader}>
              <Text style={styles.itemTitle} numberOfLines={1}>{shortTicketTitle(item.title)}</Text>
              <View style={styles.itemDateCol}>
                <Text style={styles.itemDateYear}>{yearLabel}</Text>
                <Text style={styles.itemDate}>{dayLabel}</Text>
              </View>
            </View>
            <View style={styles.metaRow}>
              <Text style={[styles.tag, { color: groupColor(item, colors), backgroundColor: groupSoft(item, colors) }]}>
                {labelOf(item)}
              </Text>
              {essay ? (
                <Text style={styles.moodText}>{item.mood}{item.weather ? ` · ${item.weather}` : ''}</Text>
              ) : renderStars(stars, colors, styles)}
            </View>
            {!!textLine && <Text style={styles.itemSubtitle} numberOfLines={1}>{textLine}</Text>}
          </View>
        </View>
      </PressableScale>
    </ReanimatedSwipeable>
  );
});

const makeStyles = (c) => ({
  swipeContainer: { backgroundColor: c.bgElevated },
  cardRow: { backgroundColor: c.bgElevated },
  // 固定行高 = 封面 64 + 上下内边距 16×2，有无评论都一样高
  cardItem: { flexDirection: 'row', padding: 16, height: 96, alignItems: 'center' },
  cardItemBorder: { borderBottomWidth: 1, borderBottomColor: c.divider },
  itemContent: { flex: 1, justifyContent: 'center' },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
  itemTitle: { fontSize: 16, fontWeight: '600', color: c.text, flex: 1, marginRight: 8 },
  // 年份一行、月-日一行，右对齐；两行加起来 ≈ 30pt，行高固定 96 也装得下
  itemDateCol: { alignItems: 'flex-end', flexShrink: 0 },
  itemDateYear: { fontSize: 11, color: c.textMuted, lineHeight: 14 },
  itemDate: { fontSize: 13, color: c.textSecondary, lineHeight: 16, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  tag: { fontSize: 10.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  moodText: { fontSize: 12, color: c.textMuted },
  starContainer: { flexDirection: 'row' },
  // 星级用字形画：lineHeight 对齐原来图标的 12px 视觉高度
  starGlyph: { fontSize: 12.5, lineHeight: 16, letterSpacing: 1.2, includeFontPadding: false },
  starIcon: { marginRight: 2 },
  itemSubtitle: { fontSize: 14, color: c.textSecondary, lineHeight: 18 },

  // 右滑操作区
  swipeActions: { flexDirection: 'row', alignItems: 'stretch', width: ACTIONS_WIDTH, paddingLeft: 8 },
  swipeBtnWrap: { width: BTN_WIDTH, paddingVertical: 8 },
  swipeBtn: { flex: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeEditBtn: { backgroundColor: c.accent },
  swipeDeleteBtn: { backgroundColor: c.danger },
  swipeBtnText: { color: '#FFF', fontSize: 12, fontWeight: '600' },
});

export default RecordRow;
