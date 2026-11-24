import React from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import NativeIcon from './NativeIcon';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { formatStorageSize } from '../utils/storagePaths';

const BUCKET_COLORS = (c) => ({
  records: c.accent,
  covers: c.purple,
  media: c.orange,
  imageCache: c.groupNote,
  mapCache: '#0EA5E9',
  temp: c.danger,
  system: c.textMuted,
});

// 仿苹果「iPhone 储存空间」样式的数据占用详情页：
// 顶部汇总总大小（与系统「文稿与数据」同口径）+ 彩色占比条，下方按类别清晰展示，
// 不再把大段原始路径/调试文本硬塞进 Alert 弹窗。
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
  const dotColors = BUCKET_COLORS(colors);

  const items = summary?.items || [];
  const totalBytes = summary?.totalBytes || 0;
  const barSegments = totalBytes > 0
    ? items.filter((it) => it.bytes > 0).map((it) => ({
        key: it.key,
        flex: Math.max(0.02, it.bytes / totalBytes),
        color: dotColors[it.key] || colors.textMuted,
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
            <Text style={styles.loadingText}>正在统计沙盒占用…</Text>
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={Platform.OS === 'ios'}
            contentContainerStyle={[styles.content, { paddingBottom: Math.max(36, insets.bottom + 24) }]}
          >
            {/* 总占用汇总卡 */}
            <View style={styles.card}>
              <Text style={styles.summaryLabel}>
                {summary?.exact ? '文稿与数据总占用' : '应用数据总占用'}
              </Text>
              <Text style={styles.summaryTotal}>{formatStorageSize(totalBytes)}</Text>
              <Text style={styles.summarySub}>
                共 {summary?.totalFiles || 0} 个文件 · {summary?.locationNote || ''}
              </Text>

              {/* 彩色占比条 */}
              <View style={styles.barTrack}>
                {barSegments.map((seg) => (
                  <View
                    key={seg.key}
                    style={[styles.barSeg, { flex: seg.flex, backgroundColor: seg.color }]}
                  />
                ))}
              </View>
            </View>

            {/* 分类明细卡 */}
            <Text style={styles.groupTitle}>占用明细</Text>
            <View style={styles.listCard}>
              {items.map((item, idx) => (
                <View key={item.key}>
                  <View style={styles.row}>
                    <View style={[styles.dot, { backgroundColor: dotColors[item.key] || colors.textMuted }]} />
                    <View style={styles.rowCopy}>
                      <Text style={styles.rowTitle}>{item.label}</Text>
                      <Text style={styles.rowNote}>{item.note}</Text>
                    </View>
                    <View style={styles.rowRight}>
                      <Text style={styles.rowSize}>{formatStorageSize(item.bytes)}</Text>
                      <Text style={styles.rowFiles}>{item.files} 项</Text>
                    </View>
                  </View>
                  {idx < items.length - 1 && <View style={styles.divider} />}
                </View>
              ))}
            </View>

            {/* 草稿提醒（仅当添加页有未保存的分享副本时显示） */}
            {!!copiesInfo?.draft && (
              <View style={styles.draftCard}>
                <Text style={styles.draftText}>
                  「添加」页草稿里还有 {copiesInfo.draft} 个未保存的本地副本，清空后可释放空间。
                </Text>
                <TouchableOpacity style={styles.draftBtn} onPress={onClearDraft} activeOpacity={0.8}>
                  <Text style={styles.draftBtnText}>清空添加页草稿</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* 快捷清理入口 */}
            <TouchableOpacity style={styles.cleanBtn} onPress={onOpenCleanCache} activeOpacity={0.85}>
              <Text style={styles.cleanBtnText}>前往清理缓存</Text>
            </TouchableOpacity>

            <Text style={styles.footnote}>
              {summary?.exact
                ? '采用与 iOS 系统「设置 → iPhone 储存空间」一致的磁盘实际占用与十进制换算（1 MB = 1000 KB）。'
                : '不含系统相册里的原始照片与视频（应用仅保存引用，不复制原片）。'}
            </Text>
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
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 14, color: c.textMuted },
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
  summarySub: { fontSize: 12.5, color: c.textSecondary, marginTop: 4, lineHeight: 18 },
  barTrack: {
    flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden',
    backgroundColor: c.fill, marginTop: 14, gap: 1.5,
  },
  barSeg: { height: '100%' },

  groupTitle: {
    fontSize: 13, fontWeight: '500', color: c.textMuted, paddingHorizontal: 8, marginTop: 4, marginBottom: -6,
  },
  listCard: {
    backgroundColor: c.bgElevated, borderRadius: 16, overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, gap: 12,
  },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 15, fontWeight: '500', color: c.text },
  rowNote: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  rowRight: { alignItems: 'flex-end', flexShrink: 0 },
  rowSize: { fontSize: 15, fontWeight: '600', color: c.textStrong, fontVariant: ['tabular-nums'] },
  rowFiles: { fontSize: 11.5, color: c.textMuted, marginTop: 1, fontVariant: ['tabular-nums'] },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.divider, marginLeft: 38 },

  draftCard: {
    backgroundColor: c.warnSoft, borderRadius: 14, padding: 14, gap: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.warnText,
  },
  draftText: { fontSize: 13, color: c.warnText, lineHeight: 19 },
  draftBtn: {
    alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
    backgroundColor: c.bgElevated,
  },
  draftBtnText: { fontSize: 13, fontWeight: '600', color: c.warnText },

  cleanBtn: {
    height: 48, borderRadius: 14, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  cleanBtnText: { fontSize: 15.5, fontWeight: '600', color: c.textOnAccent },
  footnote: { fontSize: 12, color: c.textMuted, lineHeight: 18, textAlign: 'center', paddingHorizontal: 8 },
});
