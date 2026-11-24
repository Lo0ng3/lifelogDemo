import React from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import NativeIcon from './NativeIcon';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { formatStorageSize } from '../utils/storagePaths';

// 精简为 4 项清晰分类，合计严格等于系统「文稿与数据」总占用
const buildDisplayGroups = (summary, colors) => {
  const byKey = new Map((summary?.items || []).map((it) => [it.key, it]));
  const sum = (...keys) => keys.reduce((acc, k) => acc + (byKey.get(k)?.bytes || 0), 0);
  return [
    { key: 'app', label: '应用数据', bytes: sum('records', 'covers', 'media'), color: colors.accent },
    { key: 'imageCache', label: '图片缓存', bytes: sum('imageCache'), color: colors.groupNote },
    { key: 'mapCache', label: '地图缓存', bytes: sum('mapCache'), color: '#0EA5E9' },
    { key: 'other', label: '临时与系统', bytes: sum('temp', 'system'), color: colors.textMuted },
  ];
};

export default function StorageModal({
  visible,
  loading,
  summary,
  copiesInfo,
  onClose,
  onOpenCleanCache,
  onClearDraft,
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const groups = buildDisplayGroups(summary, colors);
  const totalBytes = summary?.totalBytes || 0;
  const barSegments = totalBytes > 0
    ? groups.filter((g) => g.bytes > 0).map((g) => ({
        key: g.key,
        flex: Math.max(0.025, g.bytes / totalBytes),
        color: g.color,
      }))
    : [];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      onRequestClose={onClose}
    >
      <View style={[styles.container, { paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerSide} />
          <Text style={styles.headerTitle}>数据与存储</Text>
          <TouchableOpacity
            style={styles.headerSide}
            onPress={onClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <NativeIcon name="xmark" fallback={X} size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={Platform.OS === 'ios'}
            contentContainerStyle={[styles.content, { paddingBottom: Math.max(32, insets.bottom + 20) }]}
          >
            <View style={styles.card}>
              <Text style={styles.summaryLabel}>文稿与数据</Text>
              <Text style={styles.summaryTotal}>{formatStorageSize(totalBytes)}</Text>
              <View style={styles.barTrack}>
                {barSegments.map((seg) => (
                  <View
                    key={seg.key}
                    style={[styles.barSeg, { flex: seg.flex, backgroundColor: seg.color }]}
                  />
                ))}
              </View>
            </View>

            <View style={styles.listCard}>
              {groups.map((item, idx) => (
                <View key={item.key}>
                  <View style={styles.row}>
                    <View style={[styles.dot, { backgroundColor: item.color }]} />
                    <Text style={styles.rowTitle}>{item.label}</Text>
                    <Text style={styles.rowSize}>{formatStorageSize(item.bytes)}</Text>
                  </View>
                  {idx < groups.length - 1 && <View style={styles.divider} />}
                </View>
              ))}
            </View>

            {!!copiesInfo?.draft && (
              <View style={styles.draftCard}>
                <Text style={styles.draftText}>
                  添加页草稿含 {copiesInfo.draft} 个未保存副本
                </Text>
                <TouchableOpacity style={styles.draftBtn} onPress={onClearDraft} activeOpacity={0.8}>
                  <Text style={styles.draftBtnText}>清空草稿</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity style={styles.cleanBtn} onPress={onOpenCleanCache} activeOpacity={0.85}>
              <Text style={styles.cleanBtnText}>清理缓存</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const makeStyles = (c) => ({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: c.bgElevated,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  headerSide: { width: 32, alignItems: 'flex-end' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: c.textStrong },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 14 },

  card: {
    backgroundColor: c.bgElevated, borderRadius: 16, padding: 18,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  summaryLabel: { fontSize: 13, color: c.textMuted, fontWeight: '500' },
  summaryTotal: {
    fontSize: 32, fontWeight: '800', color: c.textStrong, marginTop: 4,
    letterSpacing: -0.6, fontVariant: ['tabular-nums'],
  },
  barTrack: {
    flexDirection: 'row', height: 9, borderRadius: 5, overflow: 'hidden',
    backgroundColor: c.fill, marginTop: 14, gap: 1.5,
  },
  barSeg: { height: '100%' },

  listCard: {
    backgroundColor: c.bgElevated, borderRadius: 16, overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 52, gap: 12,
  },
  dot: { width: 9, height: 9, borderRadius: 5, flexShrink: 0 },
  rowTitle: { flex: 1, fontSize: 15.5, fontWeight: '500', color: c.text },
  rowSize: { fontSize: 15, fontWeight: '600', color: c.textSecondary, fontVariant: ['tabular-nums'] },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.divider, marginLeft: 37 },

  draftCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: c.warnSoft, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.warnText,
  },
  draftText: { fontSize: 13.5, color: c.warnText, flex: 1, marginRight: 10 },
  draftBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: c.bgElevated,
  },
  draftBtnText: { fontSize: 13, fontWeight: '600', color: c.warnText },

  cleanBtn: {
    height: 48, borderRadius: 14, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  cleanBtnText: { fontSize: 15.5, fontWeight: '600', color: c.textOnAccent },
});
