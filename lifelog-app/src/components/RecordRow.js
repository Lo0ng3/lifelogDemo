import React, { useContext } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { Star, StarHalf, Edit3, Trash2 } from 'lucide-react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Reanimated, { useAnimatedStyle, interpolate, Extrapolation } from 'react-native-reanimated';

import CoverIcon from './CoverIcon';
import PressableScale from './PressableScale';
import { LogContext } from '../context/LogContext';
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
  const { deleteLog } = useContext(LogContext);

  const stars = starsOf(item.rating);
  const essay = isEssay(item);
  // 列表只显示日期（时分放到详情页）；正文一行，保证每行高度完全一致
  const dayLabel = String(item.date || '').slice(5, 10);
  const textLine = [item.subtitle, item.comment].filter(Boolean).join(' · ');

  const confirmDelete = () => Alert.alert(
    '删除印记',
    `确定要删除「${item.title}」吗？删除后无法恢复。`,
    [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => deleteLog(item.id) },
    ]
  );

  const renderRightActions = (_progress, drag, swipeable) => (
    <SwipeActions
      drag={drag}
      onEdit={() => { swipeable.close(); onEdit?.(item); }}
      onDelete={() => {
        swipeable.close();
        // 关闭动画走完再弹确认，避免两套动画打架
        setTimeout(confirmDelete, 120);
      }}
    />
  );

  return (
    <ReanimatedSwipeable
      renderRightActions={renderRightActions}
      overshootRight={false}
      friction={1.7}
      rightThreshold={36}
      onSwipeableWillOpen={lightTap}
      containerStyle={[styles.swipeContainer, style]}
    >
      <PressableScale style={styles.cardRow} onPress={() => onPress?.(item)}>
        <View style={[styles.cardItem, !isLast && styles.cardItemBorder]}>
          <CoverIcon item={item} height={64} />
          <View style={styles.itemContent}>
            <View style={styles.itemHeader}>
              <Text style={styles.itemTitle} numberOfLines={1}>{shortTicketTitle(item.title)}</Text>
              <Text style={styles.itemDate}>{dayLabel}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={[styles.tag, { color: groupColor(item, colors), backgroundColor: groupSoft(item, colors) }]}>
                {labelOf(item)}
              </Text>
              {essay ? (
                <Text style={styles.moodText}>{item.mood}{item.weather ? ` · ${item.weather}` : ''}</Text>
              ) : (
                <View style={styles.starContainer}>
                  {[1, 2, 3, 4, 5].map((i) => {
                    if (!stars) return null;
                    const isFull = i <= stars.full;
                    const isHalf = stars.half && i === stars.full + 1;
                    if (isHalf) return <StarHalf key={i} size={12} color={colors.star} fill={colors.star} style={{ marginRight: 2 }} />;
                    return <Star key={i} size={12} color={isFull ? colors.star : colors.starEmpty} fill={isFull ? colors.star : 'transparent'} style={{ marginRight: 2 }} />;
                  })}
                </View>
              )}
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
  itemDate: { fontSize: 12, color: c.textMuted },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  tag: { fontSize: 10.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  moodText: { fontSize: 12, color: c.textMuted },
  starContainer: { flexDirection: 'row' },
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
