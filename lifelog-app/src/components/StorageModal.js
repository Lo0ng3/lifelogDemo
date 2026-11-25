import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import NativeIcon from './NativeIcon';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { formatStorageSize } from '../utils/storagePaths';
import { hapticSelection } from '../utils/haptics';

// 精简为 4 项清晰分类，合计严格等于系统「文稿与数据」总占用
const buildDisplayGroups = (summary, colors) => {
  const byKey = new Map((summary?.items || []).map((it) => [it.key, it]));
  const sumBytes = (...keys) => keys.reduce((acc, k) => acc + (byKey.get(k)?.bytes || 0), 0);
  const sumFiles = (...keys) => keys.reduce((acc, k) => acc + (byKey.get(k)?.files || 0), 0);
  return [
    {
      key: 'app',
      label: '应用数据',
      bytes: sumBytes('records', 'covers', 'media'),
      files: sumFiles('records', 'covers', 'media'),
      color: colors.accent,
    },
    {
      key: 'imageCache',
      label: '图片缓存',
      bytes: sumBytes('imageCache'),
      files: sumFiles('imageCache'),
      color: colors.groupNote,
    },
    {
      key: 'mapCache',
      label: '地图缓存',
      bytes: sumBytes('mapCache'),
      files: sumFiles('mapCache'),
      color: '#0EA5E9',
    },
    {
      key: 'other',
      label: '临时与系统',
      bytes: sumBytes('temp', 'system'),
      files: sumFiles('temp', 'system'),
      color: colors.textMuted,
    },
  ];
};

const SUB_BAR_PALETTE = ['#1D63ED', '#109B6A', '#EA7A2E', '#8B5CF6', '#0EA5E9', '#DC4C46', '#6B7280'];

const basenameOf = (uri) => {
  if (typeof uri !== 'string' || !uri) return '';
  const clean = uri.split('?')[0];
  const cut = clean.lastIndexOf('/');
  return cut >= 0 ? clean.slice(cut + 1) : clean;
};

// 把本地文件名反查到所属印记记录，点开「应用数据」时可直接看出是哪条记录占了空间
const buildFileOwnerMap = (logs) => {
  const map = new Map();
  if (!Array.isArray(logs)) return map;
  for (const log of logs) {
    if (!log) continue;
    const title = String(log.title || '未命名印记').trim() || '未命名印记';
    const date = String(log.date || '').slice(0, 10);
    const register = (uri, role) => {
      const name = basenameOf(uri);
      if (name && !map.has(name)) map.set(name, { title, date, role });
    };
    register(log.coverUrl, '封面图');
    register(log.coverThumbUrl, '封面缩略图');
    if (Array.isArray(log.localImages)) {
      for (const entry of log.localImages) {
        if (typeof entry === 'string') {
          register(entry, '本地媒体副本');
        } else if (entry && typeof entry === 'object') {
          register(entry.uri, entry.isVideo ? '视频副本' : '照片副本');
          if (entry.videoPoster?.uri) register(entry.videoPoster.uri, '视频封面');
        }
      }
    }
  }
  return map;
};

const formatPercent = (part, total) => {
  if (!total || total <= 0 || !part || part <= 0) return '0%';
  const pct = (part / total) * 100;
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
};

const describeFileEntry = (file, ownerMap, copiesInfo) => {
  const owner = ownerMap.get(file.name);
  if (owner) {
    return {
      title: owner.title,
      badge: owner.role,
      sub: [owner.date, file.name].filter(Boolean).join(' · '),
    };
  }
  if (file.subKey === 'media') {
    return {
      title: copiesInfo?.draft ? '草稿或未引用本地副本' : '未引用本地媒体副本',
      badge: '媒体副本',
      sub: file.relPath || file.name,
    };
  }
  if (file.subKey === 'internalBackup') {
    return {
      title: '本地自动备份文件',
      badge: '备份',
      sub: file.relPath || file.name,
    };
  }
  if (file.subKey === 'profile') {
    return {
      title: '个人头像文件',
      badge: '头像',
      sub: file.relPath || file.name,
    };
  }
  if (file.subKey === 'asyncStorage') {
    return {
      title: '记录与配置数据',
      badge: '数据库',
      sub: file.relPath || file.name,
    };
  }
  return {
    title: file.name || file.subLabel || '未知文件',
    badge: file.subLabel || '',
    sub: file.relPath || '',
  };
};

export default function StorageModal({
  visible,
  loading,
  summary,
  copiesInfo,
  logs,
  onClose,
  onOpenCleanCache,
  onClearDraft,
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const [selectedGroupKey, setSelectedGroupKey] = useState(null);
  const [selectedSubKey, setSelectedSubKey] = useState(null);

  useEffect(() => {
    if (!visible) {
      setSelectedGroupKey(null);
      setSelectedSubKey(null);
    }
  }, [visible]);

  const groups = useMemo(() => buildDisplayGroups(summary, colors), [summary, colors]);
  const ownerMap = useMemo(() => buildFileOwnerMap(logs), [logs]);

  const totalBytes = summary?.totalBytes || 0;
  const barSegments = totalBytes > 0
    ? groups.filter((g) => g.bytes > 0).map((g) => ({
        key: g.key,
        flex: Math.max(0.025, g.bytes / totalBytes),
        color: g.color,
      }))
    : [];

  const activeGroup = selectedGroupKey
    ? groups.find((g) => g.key === selectedGroupKey) || null
    : null;

  const activeSubItems = useMemo(() => {
    if (!activeGroup) return [];
    const list = (summary?.subItems || []).filter((s) => s.group === activeGroup.key && (s.bytes > 0 || s.files > 0));
    return list.sort((a, b) => b.bytes - a.bytes);
  }, [activeGroup, summary]);

  const activeFiles = useMemo(() => {
    if (!activeGroup) return [];
    const list = summary?.topFiles?.[activeGroup.key] || [];
    if (!selectedSubKey) return list;
    return list.filter((f) => f.subKey === selectedSubKey);
  }, [activeGroup, summary, selectedSubKey]);

  const activeSubLabel = useMemo(() => {
    if (!selectedSubKey) return '';
    return activeSubItems.find((s) => s.key === selectedSubKey)?.label || '';
  }, [activeSubItems, selectedSubKey]);

  const subBarSegments = useMemo(() => {
    if (!activeGroup || activeGroup.bytes <= 0) return [];
    return activeSubItems
      .filter((s) => s.bytes > 0)
      .map((s, idx) => ({
        key: s.key,
        flex: Math.max(0.03, s.bytes / activeGroup.bytes),
        color: SUB_BAR_PALETTE[idx % SUB_BAR_PALETTE.length],
      }));
  }, [activeGroup, activeSubItems]);

  const handleBackOrClose = () => {
    if (selectedGroupKey) {
      setSelectedGroupKey(null);
      setSelectedSubKey(null);
      return;
    }
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      onRequestClose={handleBackOrClose}
    >
      <View style={[styles.container, { paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}>
        <View style={styles.header}>
          {activeGroup ? (
            <TouchableOpacity
              style={styles.headerBack}
              onPress={() => {
                hapticSelection();
                setSelectedGroupKey(null);
                setSelectedSubKey(null);
              }}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <NativeIcon name="chevron.left" fallback={ChevronLeft} size={20} color={colors.accent} weight="semibold" />
              <Text style={styles.headerBackText}>返回</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.headerSideLeft} />
          )}
          <Text style={styles.headerTitle} numberOfLines={1}>
            {activeGroup ? activeGroup.label : '数据与存储'}
          </Text>
          <TouchableOpacity
            style={styles.headerSideRight}
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
        ) : activeGroup ? (
          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={Platform.OS === 'ios'}
            contentContainerStyle={[styles.content, { paddingBottom: Math.max(32, insets.bottom + 20) }]}
          >
            <View style={styles.card}>
              <View style={styles.detailTopRow}>
                <View style={styles.detailTitleRow}>
                  <View style={[styles.dot, { backgroundColor: activeGroup.color }]} />
                  <Text style={styles.summaryLabel}>{activeGroup.label}</Text>
                </View>
                <Text style={styles.sharePill}>
                  占总存储 {formatPercent(activeGroup.bytes, totalBytes)}
                </Text>
              </View>
              <Text style={styles.summaryTotal}>{formatStorageSize(activeGroup.bytes)}</Text>
              <Text style={styles.detailMeta}>共 {activeGroup.files} 个文件</Text>
              {subBarSegments.length > 0 && (
                <View style={styles.barTrack}>
                  {subBarSegments.map((seg) => (
                    <View
                      key={seg.key}
                      style={[styles.barSeg, { flex: seg.flex, backgroundColor: seg.color }]}
                    />
                  ))}
                </View>
              )}
            </View>

            <Text style={styles.sectionLabel}>占用构成</Text>
            {activeSubItems.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>当前分类暂无占用</Text>
              </View>
            ) : (
              <View style={styles.listCard}>
                {activeSubItems.map((sub, idx) => {
                  const subColor = SUB_BAR_PALETTE[idx % SUB_BAR_PALETTE.length];
                  const selected = selectedSubKey === sub.key;
                  const ratio = activeGroup.bytes > 0 ? Math.min(1, sub.bytes / activeGroup.bytes) : 0;
                  return (
                    <View key={sub.key}>
                      <TouchableOpacity
                        style={[styles.subRow, selected && styles.subRowSelected]}
                        activeOpacity={0.7}
                        onPress={() => {
                          hapticSelection();
                          setSelectedSubKey((prev) => (prev === sub.key ? null : sub.key));
                        }}
                      >
                        <View style={styles.subTopLine}>
                          <View style={[styles.subDot, { backgroundColor: subColor }]} />
                          <Text style={styles.subTitle} numberOfLines={1}>{sub.label}</Text>
                          <Text style={styles.subPct}>{formatPercent(sub.bytes, activeGroup.bytes)}</Text>
                          <Text style={styles.subSize}>{formatStorageSize(sub.bytes)}</Text>
                        </View>
                        <Text style={styles.subNote} numberOfLines={2}>
                          {sub.files} 个文件{sub.note ? ` · ${sub.note}` : ''}
                        </Text>
                        <View style={styles.subBarTrack}>
                          <View
                            style={[
                              styles.subBarFill,
                              { width: `${Math.max(2, Math.round(ratio * 100))}%`, backgroundColor: subColor },
                            ]}
                          />
                        </View>
                      </TouchableOpacity>
                      {idx < activeSubItems.length - 1 && <View style={styles.subDivider} />}
                    </View>
                  );
                })}
              </View>
            )}

            <View style={styles.sectionRow}>
              <Text style={styles.sectionLabelInline}>
                {selectedSubKey ? `较大文件 · ${activeSubLabel}` : '较大文件'}
              </Text>
              {selectedSubKey && (
                <TouchableOpacity
                  onPress={() => { hapticSelection(); setSelectedSubKey(null); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.sectionAction}>查看全部</Text>
                </TouchableOpacity>
              )}
            </View>

            {activeFiles.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>
                  {selectedSubKey ? '该子项下暂无大文件明细' : '暂无可展示的文件明细'}
                </Text>
              </View>
            ) : (
              <View style={styles.listCard}>
                {activeFiles.map((file, idx) => {
                  const info = describeFileEntry(file, ownerMap, copiesInfo);
                  return (
                    <View key={`${file.relPath || file.name}-${idx}`}>
                      <View style={styles.fileRow}>
                        <View style={styles.fileCopy}>
                          <View style={styles.fileTitleLine}>
                            <Text style={styles.fileTitle} numberOfLines={1}>{info.title}</Text>
                            {!!info.badge && (
                              <View style={styles.fileBadge}>
                                <Text style={styles.fileBadgeText} numberOfLines={1}>{info.badge}</Text>
                              </View>
                            )}
                          </View>
                          {!!info.sub && (
                            <Text style={styles.fileSub} numberOfLines={1} ellipsizeMode="middle">
                              {info.sub}
                            </Text>
                          )}
                        </View>
                        <Text style={styles.fileSize}>{formatStorageSize(file.bytes)}</Text>
                      </View>
                      {idx < activeFiles.length - 1 && <View style={styles.fileDivider} />}
                    </View>
                  );
                })}
              </View>
            )}

            {activeGroup.key === 'app' && !!copiesInfo?.draft && (
              <View style={styles.draftCard}>
                <Text style={styles.draftText}>
                  添加页草稿含 {copiesInfo.draft} 个未保存副本
                </Text>
                <TouchableOpacity style={styles.draftBtn} onPress={onClearDraft} activeOpacity={0.8}>
                  <Text style={styles.draftBtnText}>清空草稿</Text>
                </TouchableOpacity>
              </View>
            )}

            {activeGroup.key !== 'app' && activeGroup.bytes > 0 && (
              <TouchableOpacity style={styles.cleanBtn} onPress={onOpenCleanCache} activeOpacity={0.85}>
                <Text style={styles.cleanBtnText}>去清理缓存</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
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
                  <TouchableOpacity
                    style={styles.row}
                    activeOpacity={0.68}
                    delayPressIn={0}
                    onPress={() => {
                      hapticSelection();
                      setSelectedSubKey(null);
                      setSelectedGroupKey(item.key);
                    }}
                  >
                    <View style={[styles.dot, { backgroundColor: item.color }]} />
                    <View style={styles.rowCopy}>
                      <Text style={styles.rowTitle}>{item.label}</Text>
                      {item.files > 0 && (
                        <Text style={styles.rowSub}>{item.files} 个文件</Text>
                      )}
                    </View>
                    <Text style={styles.rowSize}>{formatStorageSize(item.bytes)}</Text>
                    <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />
                  </TouchableOpacity>
                  {idx < groups.length - 1 && <View style={styles.divider} />}
                </View>
              ))}
            </View>
            <Text style={styles.hintText}>点按任意分类可查看具体子项与占用文件</Text>

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
  headerSideLeft: { width: 64 },
  headerSideRight: { width: 64, alignItems: 'flex-end' },
  headerBack: { width: 64, flexDirection: 'row', alignItems: 'center', gap: 2 },
  headerBackText: { fontSize: 15.5, fontWeight: '500', color: c.accent },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: c.textStrong },
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
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, minHeight: 56, gap: 12,
  },
  dot: { width: 9, height: 9, borderRadius: 5, flexShrink: 0 },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15.5, fontWeight: '500', color: c.text },
  rowSub: { fontSize: 12, color: c.textMuted },
  rowSize: { fontSize: 15, fontWeight: '600', color: c.textSecondary, fontVariant: ['tabular-nums'] },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.divider, marginLeft: 37 },
  hintText: { fontSize: 12.5, color: c.textMuted, paddingHorizontal: 6, marginTop: -6 },

  detailTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  detailTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sharePill: {
    fontSize: 12, fontWeight: '600', color: c.textSecondary,
    backgroundColor: c.bgSunken, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 99,
    overflow: 'hidden',
  },
  detailMeta: { fontSize: 12.5, color: c.textMuted, marginTop: 4 },

  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: -4, paddingHorizontal: 6 },
  sectionLabel: { fontSize: 13, fontWeight: '500', color: c.textMuted, paddingHorizontal: 6, marginTop: 4, marginBottom: -4 },
  sectionLabelInline: { fontSize: 13, fontWeight: '500', color: c.textMuted },
  sectionAction: { fontSize: 13, fontWeight: '600', color: c.accent },

  subRow: { paddingHorizontal: 16, paddingVertical: 13, gap: 6 },
  subRowSelected: { backgroundColor: c.accentTint },
  subTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  subTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text },
  subPct: { fontSize: 12.5, color: c.textMuted, fontVariant: ['tabular-nums'] },
  subSize: { fontSize: 14.5, fontWeight: '600', color: c.textStrong, fontVariant: ['tabular-nums'], minWidth: 62, textAlign: 'right' },
  subNote: { fontSize: 12, color: c.textMuted, paddingLeft: 16, lineHeight: 17 },
  subBarTrack: { height: 4, borderRadius: 2, backgroundColor: c.fill, overflow: 'hidden', marginLeft: 16, marginTop: 2 },
  subBarFill: { height: '100%', borderRadius: 2 },
  subDivider: { height: StyleSheet.hairlineWidth, backgroundColor: c.divider, marginLeft: 32 },

  fileRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 10,
  },
  fileCopy: { flex: 1, gap: 3 },
  fileTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fileTitle: { fontSize: 14.5, fontWeight: '500', color: c.text, flexShrink: 1 },
  fileBadge: {
    backgroundColor: c.bgSunken, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  fileBadgeText: { fontSize: 11, fontWeight: '500', color: c.textSecondary },
  fileSub: { fontSize: 12, color: c.textMuted },
  fileSize: { fontSize: 14, fontWeight: '600', color: c.textSecondary, fontVariant: ['tabular-nums'] },
  fileDivider: { height: StyleSheet.hairlineWidth, backgroundColor: c.divider, marginLeft: 16 },

  emptyCard: {
    backgroundColor: c.bgElevated, borderRadius: 16, paddingVertical: 24, paddingHorizontal: 16,
    alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  emptyText: { fontSize: 13.5, color: c.textMuted },

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
