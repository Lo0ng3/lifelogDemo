import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import PressableScale from './PressableScale';
import { useCoverSource } from './CoverIcon';
import { useTheme } from '../theme/ThemeProvider';
import { groupColor, isEssay, labelOf, TYPE_EMOJI } from '../utils/recordMeta';
import { shortTicketTitle } from '../utils/format';
import { remoteImageSource } from '../utils/media';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

const shortDate = (value) => {
  const [datePart = ''] = String(value || '').split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  if (!year || !month || !day) return value || '';
  return `${month}月${day}日 · 周${WEEKDAY[new Date(year, month - 1, day).getDay()]}`;
};

export default function FeatureCard({ item, onPress }) {
  const { colors } = useTheme();
  const { src, iconBgColor } = useCoverSource(item);
  if (!item) return null;

  const accent = groupColor(item, colors);
  const essay = isEssay(item);
  const badge = essay
    ? (item.mood || '随笔')
    : item.rating
      ? `★ ${Number(item.rating).toFixed(1)}`
      : '未评分';

  return (
    <PressableScale style={styles.shell} onPress={() => onPress?.(item)} activeScale={0.988}>
      <View style={styles.media}>
        {src ? (
          <Image
            source={src.startsWith('http') ? remoteImageSource(src) : { uri: src }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
          />
        ) : (
          <LinearGradient
            colors={[iconBgColor, colors.surfaceDeep, '#101722']}
            style={StyleSheet.absoluteFill}
          >
            <Text style={styles.fallbackEmoji}>{TYPE_EMOJI[item.subType] || TYPE_EMOJI[item.baseType] || '📍'}</Text>
          </LinearGradient>
        )}
        <LinearGradient
          colors={['rgba(3,7,13,0.02)', 'rgba(3,7,13,0.08)', 'rgba(3,7,13,0.86)']}
          locations={[0, 0.45, 1]}
          style={StyleSheet.absoluteFill}
        />

        <View style={styles.topRow}>
          <View style={styles.typePill}>
            <View style={[styles.typeDot, { backgroundColor: accent }]} />
            <Text style={styles.typeText}>{labelOf(item)}</Text>
          </View>
          <View style={styles.ratingPill}>
            <Text style={styles.ratingText}>{badge}</Text>
          </View>
        </View>

        <View style={styles.copy}>
          <Text style={styles.date}>{shortDate(item.date)}</Text>
          <Text style={styles.title} numberOfLines={1}>{shortTicketTitle(item.title)}</Text>
          {!!(item.subtitle || item.comment) && (
            <Text style={styles.note} numberOfLines={2}>{item.subtitle || item.comment}</Text>
          )}
        </View>
      </View>
    </PressableScale>
  );
}

export function MiniCover({ item, size = 27 }) {
  const { colors } = useTheme();
  const { src, iconBgColor } = useCoverSource(item);
  return (
    <View style={[styles.miniCover, { width: size, height: size, borderColor: colors.glassBorder }]}>
      {src ? (
        <Image
          source={src.startsWith('http') ? remoteImageSource(src) : { uri: src }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: iconBgColor }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    height: 246,
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: '#111820',
    shadowColor: '#07101C',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.22,
    shadowRadius: 30,
    elevation: 7,
  },
  media: {
    flex: 1,
  },
  fallbackEmoji: {
    marginTop: 74,
    textAlign: 'center',
    fontSize: 54,
    opacity: 0.92,
  },
  topRow: {
    position: 'absolute',
    left: 13,
    right: 13,
    top: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  typePill: {
    height: 25,
    paddingHorizontal: 9,
    borderRadius: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(6,11,18,0.42)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  typeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  typeText: {
    color: '#FFF',
    fontSize: 9.5,
    fontWeight: '600',
  },
  ratingPill: {
    height: 25,
    paddingHorizontal: 9,
    borderRadius: 13,
    justifyContent: 'center',
    backgroundColor: 'rgba(6,11,18,0.42)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  ratingText: {
    color: '#FFD45E',
    fontSize: 9.5,
    fontWeight: '700',
  },
  copy: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
  },
  date: {
    color: 'rgba(255,255,255,0.74)',
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 0.2,
    marginBottom: 4,
  },
  title: {
    color: '#FFF',
    fontSize: 23,
    lineHeight: 27,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  note: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 11.5,
    lineHeight: 17,
    marginTop: 5,
  },
  miniCover: {
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1.5,
    marginLeft: -8,
    backgroundColor: '#111820',
  },
});
