import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, Platform, Alert, BackHandler, ToastAndroid,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { Search, Plus, PlayCircle, X } from 'lucide-react-native';

import { LogContext } from '../context/LogContext';
import CoverIcon from '../components/CoverIcon';
import { makeMediaIndex, isVideoEntry, mediaUri } from '../utils/media';
import { relinkNewEntries } from '../utils/mediaSync';
import { labelOf, groupColor, groupSoft } from '../utils/recordMeta';
import { shortTicketTitle } from '../utils/format';
import { MEDIA_DIR } from '../utils/storagePaths';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';

// 应用自己复制出来的副本（MEDIA_DIR 里的）才能删；相册、用户文件绝不动
const isAppCopy = (uri) => typeof uri === 'string' && uri.startsWith('file://') && uri.startsWith(`${MEDIA_DIR}/`);

const discardUris = async (uris) => {
  for (const uri of uris) {
    if (!isAppCopy(uri)) continue;
    try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
  }
};

// 重复被跳过的影像：说清楚是在这条记录里，还是记在别的记录里
const describeSkipped = (ownCount, otherCount) => {
  const parts = [];
  if (ownCount) parts.push(`${ownCount} 个这条记录里已经有了`);
  if (otherCount) parts.push(`${otherCount} 个已经记在别的记录里了`);
  return parts.length ? `${parts.join('，')}。` : '没有可用的影像。';
};

/* ------------------------------------------------------------------ *
 * 系统分享的落点：图库选图 → 分享 → 印记
 *
 * 早期只把影像挂到「添加」页（等于只能新建记录）；这里补上另一半：
 * 也可以直接挑一条已有记录，把影像追加到它的「相关影像」末尾。
 *
 * 两个容易出错的地方：
 *  ① 追加走的是和保存记录完全相同的流水线（先重链回相册原片、副本重链成功即删），
 *     所以分享进来的影像和手动加的在存储里没有区别；
 *  ② **去重必须"先重链再比"**：分享进来的是 media/ 里的副本（只有 文件名 + 大小），
 *     记录里存的却是相册引用（只有 assetId），直接比身份永远对不上——这就是
 *     "同一张照片被重复加进已有记录"的原因。重链后再用两套口径一起比（见 makeMediaIndex）。
 * ------------------------------------------------------------------ */
export default function ShareTargetScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { logData, updateLog } = useContext(LogContext);

  const media = useMemo(() => (route.params?.sharedMedia || []).filter((m) => m?.uri), [route.params?.sharedMedia]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  // 取消 = 这批影像没人要了：把复制进私有目录的副本删掉，别留在手机里占地方
  const discardCopies = useCallback(() => discardUris(media.map(mediaUri)), [media]);

  const handleCancel = useCallback(() => {
    if (busy) return;
    discardCopies();
    navigation.popToTop();
  }, [busy, discardCopies, navigation]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleCancel();
      return true;
    });
    return () => sub.remove();
  }, [handleCancel]);

  const records = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...logData].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    if (!q) return list;
    return list.filter((it) => [
      it.title, it.subtitle, it.comment, String(it.date || '').slice(0, 10),
    ].some((v) => String(v || '').toLowerCase().includes(q)));
  }, [logData, query]);

  // 挑一条已有记录：把影像追加到它的「相关影像」末尾
  const handlePick = useCallback(async (record) => {
    if (busy) return;
    setBusy(true);
    try {
      const existing = record.localImages || [];
      // 分享进来的文件还只是 media/ 里的副本（只有 文件名 + 大小），记录里存的却是
      // 相册引用（assetId）。先按保存记录的同一条流水线重链回相册原片，两边才算得上
      // 同一张——不然"已经记过的照片"会被当成新的一张再加一遍
      const relink = await relinkNewEntries(media);

      const ownIndex = makeMediaIndex(existing);
      const otherIndex = makeMediaIndex(
        logData.filter((log) => log.id !== record.id).flatMap((log) => log.localImages || [])
      );

      const accepted = [];
      const dupOwn = [];
      const dupOther = [];
      for (const entry of relink.entries) {
        if (ownIndex.has(entry)) { dupOwn.push(entry); continue; }        // 这条记录里已经有了
        if (otherIndex.has(entry)) { dupOther.push(entry); continue; }    // 已经记在别的记录里
        accepted.push(entry);
        ownIndex.add(entry);      // 同一批里的重复也挡掉
      }

      if (accepted.length === 0) {
        // 一张都没收下：这里不删副本——用户可能换一条记录再试，副本还得用；
        // 真的都不要了他会点取消，那条路径统一删
        Alert.alert('没有可添加的影像', describeSkipped(dupOwn.length, dupOther.length));
        return;
      }

      await updateLog({ ...record, localImages: [...existing, ...accepted] });
      // 被相册原片接管的副本删掉（应用里不留原件拷贝）；
      // 重复被跳过的那些副本也没人引用了，一并清掉（这一页马上就被替换掉，这批分享已消费完）
      discardUris([
        ...relink.replacedUris,
        ...dupOwn.map(mediaUri),
        ...dupOther.map(mediaUri),
      ]);

      const tips = [`已添加 ${accepted.length} 个影像`];
      if (dupOwn.length + dupOther.length > 0) tips.push(`跳过 ${dupOwn.length + dupOther.length} 个已记过的`);
      if (Platform.OS === 'android') ToastAndroid.show(tips.join('，'), ToastAndroid.SHORT);
      // 直接进这条记录的详情：加完就能看到结果，也能顺手调整影像顺序
      navigation.replace('Detail', { item: record });
    } catch (e) {
      Alert.alert('添加失败', e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, logData, media, navigation, updateLog]);

  // 新建印记：影像带进添加页（表单里已经挂好），类型 / 日期 / 评论照常自己填
  const handleCreate = () => {
    if (busy) return;
    navigation.replace('Main', { screen: 'Add', params: { sharedMedia: media, shareToken: Date.now() } });
  };

  const renderItem = useCallback(({ item }) => (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => handlePick(item)} disabled={busy}>
      <CoverIcon item={item} height={56} />
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>{shortTicketTitle(item.title)}</Text>
          <Text style={styles.rowDate}>{String(item.date || '').slice(0, 10)}</Text>
        </View>
        <View style={styles.rowMeta}>
          <Text style={[styles.tag, { color: groupColor(item, colors), backgroundColor: groupSoft(item, colors) }]}>
            {labelOf(item)}
          </Text>
          <Text style={styles.rowCount}>已有 {(item.localImages || []).length} 张</Text>
        </View>
      </View>
    </TouchableOpacity>
  ), [busy, colors, handlePick, styles]);

  return (
    <View style={styles.container}>
      <View style={[styles.navBar, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity style={styles.navBtn} onPress={handleCancel} disabled={busy}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>分享到印记</Text>
        <View style={styles.navBtn} />
      </View>

      <View style={styles.mediaStrip}>
        {media.slice(0, 6).map((m, i) => (
          <View key={`${m.uri}-${i}`} style={styles.mediaCell}>
            <Image source={{ uri: mediaUri(m) }} style={styles.mediaThumb} contentFit="cover" cachePolicy="memory" />
            {isVideoEntry(m) && (
              <View style={styles.mediaPlay}><PlayCircle size={18} color="#FFF" /></View>
            )}
          </View>
        ))}
        {media.length > 6 && (
          <View style={[styles.mediaCell, styles.mediaMore]}>
            <Text style={styles.mediaMoreText}>+{media.length - 6}</Text>
          </View>
        )}
        <Text style={styles.mediaCount}>共 {media.length} 个影像</Text>
      </View>

      <TouchableOpacity style={styles.createBtn} activeOpacity={0.85} onPress={handleCreate} disabled={busy}>
        <Plus size={18} color={colors.textOnAccent} />
        <Text style={styles.createBtnText}>新建印记</Text>
      </TouchableOpacity>

      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>添加到已有记录</Text>
        {busy && <ActivityIndicator size="small" color={colors.accent} />}
      </View>

      <View style={styles.searchBox}>
        <Search size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="搜索标题、关键字..."
          placeholderTextColor={colors.textMuted}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')}><X size={16} color={colors.textMuted} /></TouchableOpacity>
        )}
      </View>

      <FlatList
        data={records}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={styles.emptyText}>没有匹配的记录</Text>}
      />
    </View>
  );
}

const makeStyles = (c) => ({
  container: { flex: 1, backgroundColor: c.bg },
  navBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 8, backgroundColor: c.bgElevated,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.divider,
  },
  navBtn: { minWidth: 56 },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: c.text },
  cancelText: { fontSize: 16, color: c.textSecondary },

  mediaStrip: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 16 },
  mediaCell: { width: 52, height: 52, borderRadius: 8, overflow: 'hidden', backgroundColor: c.mediaPlaceholder },
  mediaThumb: { width: '100%', height: '100%' },
  mediaPlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  mediaMore: { alignItems: 'center', justifyContent: 'center', backgroundColor: c.fill },
  mediaMoreText: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
  mediaCount: { fontSize: 13, color: c.textMuted, marginLeft: 4 },

  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginHorizontal: 16, height: 46, borderRadius: 12, backgroundColor: c.accent,
  },
  createBtnText: { fontSize: 15, fontWeight: '600', color: c.textOnAccent },

  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 22 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: c.fill, borderRadius: 10,
    paddingHorizontal: 10, height: 36, marginHorizontal: 16, marginTop: 10,
  },
  searchInput: { flex: 1, fontSize: 14, color: c.text, paddingVertical: 0 },

  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowContent: { flex: 1 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text, marginRight: 8 },
  rowDate: { fontSize: 12, color: c.textMuted, flexShrink: 0 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tag: { fontSize: 10.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  rowCount: { fontSize: 12, color: c.textMuted },
  emptyText: { textAlign: 'center', color: c.textMuted, marginTop: 40, fontSize: 14 },
});
