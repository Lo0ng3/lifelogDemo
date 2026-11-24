import React from 'react';
import { View, Text } from 'react-native';

import CoverIcon from './CoverIcon';
import PressableScale from './PressableScale';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { labelOf, groupColor, groupSoft, isEssay, starsOf } from '../utils/recordMeta';
import { shortTicketTitle } from '../utils/format';

/* 星级：整星 / 空星 / 半星全部用同一个字形、同一个字号画，尺寸完全统一。
   每颗星占固定宽度、字形居中，半星裁掉右半边即可。 */
function renderStars(stars, colors, styles) {
  if (!stars) return null;
  const { full, half } = stars;
  return (
    <View style={styles.starContainer}>
      {[1, 2, 3, 4, 5].map((i) => {
        if (half && i === full + 1) {
          return (
            <View key={i} style={styles.starHalfClip}>
              <Text style={[styles.starGlyph, { color: colors.star }]}>★</Text>
            </View>
          );
        }
        const on = i <= full;
        return (
          <Text key={i} style={[styles.starGlyph, { color: on ? colors.star : colors.starEmpty }]}>
            {on ? '★' : '☆'}
          </Text>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * 列表 / 月示图共用的记录行
 * 仅保留轻点进详情（修改与删除统一在详情页底部操作条完成，去掉右滑操作，
 * 滚动和点击更干脆利落，不会与横向手势冲突）。
 * ------------------------------------------------------------------ */
const RecordRow = React.memo(function RecordRow({ item, isLast, onPress, style }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();

  const stars = starsOf(item.rating);
  const essay = isEssay(item);
  const dateText = String(item.date || '');
  const yearLabel = dateText.slice(0, 4);
  const dayLabel = dateText.slice(5, 10);
  const textLine = [item.subtitle, item.comment].filter(Boolean).join(' · ');

  return (
    <PressableScale style={[styles.cardRow, style]} onPress={() => onPress?.(item)}>
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
  );
});

const makeStyles = (c) => ({
  cardRow: { backgroundColor: c.bgElevated },
  // 固定行高 = 封面 64 + 上下内边距 16×2，有无评论都一样高
  cardItem: { flexDirection: 'row', padding: 16, height: 96, alignItems: 'center' },
  cardItemBorder: { borderBottomWidth: 1, borderBottomColor: c.divider },
  itemContent: { flex: 1, justifyContent: 'center' },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
  itemTitle: { fontSize: 16, fontWeight: '600', color: c.text, flex: 1, marginRight: 8 },
  itemDateCol: { alignItems: 'flex-end', flexShrink: 0 },
  itemDateYear: { fontSize: 11, color: c.textMuted, lineHeight: 14, fontVariant: ['tabular-nums'] },
  itemDate: { fontSize: 13, color: c.textSecondary, lineHeight: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  tag: { fontSize: 10.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  moodText: { fontSize: 12, color: c.textMuted },
  starContainer: { flexDirection: 'row' },
  starGlyph: { width: 14, textAlign: 'center', fontSize: 12.5, lineHeight: 16, includeFontPadding: false },
  starHalfClip: { width: 7, overflow: 'hidden' },
  itemSubtitle: { fontSize: 14, color: c.textSecondary, lineHeight: 18 },
});

export default RecordRow;
