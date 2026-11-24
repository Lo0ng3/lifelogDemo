import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  Dimensions, Animated, TextInput, Alert, ActionSheetIOS, Switch, BackHandler, ToastAndroid, Platform, Modal, ActivityIndicator,
  useWindowDimensions, Keyboard, Linking
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  User, ListFilter, Check, Search, X, RefreshCw, Upload, Download, Eraser, Settings, HelpCircle, FolderOpen,
  ChevronLeft, ChevronRight, Pencil
} from 'lucide-react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { WebView } from 'react-native-webview';
import Reanimated, {
  useAnimatedStyle, useSharedValue, withTiming, Easing, FadeIn,
} from 'react-native-reanimated';

import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  // 该库导出的手势版触摸组件名为 TouchableOpacity（无 BottomSheet 前缀），别名以免与 RN 的重名
  TouchableOpacity as BottomSheetTouchableOpacity
} from '@gorhom/bottom-sheet';

import { LogContext } from '../context/LogContext';
import RecordRow from '../components/RecordRow';
import MonthView from '../components/MonthView';
import HelpModal from '../components/HelpModal';
import LiquidGlassSurface from '../components/LiquidGlassSurface';
import NativeIcon from '../components/NativeIcon';
import NativeSegmentedControl, { hasNativeSegmentedControl } from '../components/NativeSegmentedControl';
import { hapticSelection, hapticSuccess } from '../utils/haptics';
import { exportBackup, importBackup } from '../utils/backup';
import { DEFAULT_PROFILE_NAME, loadProfile, persistAvatar, saveProfile } from '../utils/profile';
import { describeStorageAsync, clearWebKitCacheAsync } from '../utils/storagePaths';
import { cleanupMediaCaches, describeMediaCopiesAsync, pruneOrphanMediaCopies } from '../utils/media';
import { clearMotionVideoCache } from '../utils/livePhoto';
import { requestAddDraftReset } from '../utils/draftReset';
import { shortPlaceName } from '../utils/format';
import { buildPlaceAnchors, anchorOf, latLngOfPoint } from '../utils/mapPlaces';
import { buildMapHtml } from '../utils/mapHtml';
import { LEAFLET_JS, LEAFLET_CSS } from '../vendor/leafletBundle';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { getPalette } from '../theme/palette';
import { NOTE_SUB_OPTIONS, TICKET_SUB_OPTIONS, MEDIA_SUB_OPTIONS } from '../utils/recordMeta';
import { tabBarStyleFor, HIDDEN_TAB_BAR } from '../navigation/tabBarStyle';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SIDEBAR_WIDTH = SCREEN_WIDTH;

const subTypeOptions = { ticket: TICKET_SUB_OPTIONS, media: MEDIA_SUB_OPTIONS };

// 列表行高固定（RecordRow 里 cardItem 就是 96，行与行之间没有分隔线/外边距）。
// 把这个信息交给 FlatList，滚动时就不用逐行测量、也不会因为测量结果回来而"跳一下"
const ROW_HEIGHT = 96;
const rowKeyExtractor = (item) => String(item.id);
const rowItemLayout = (_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index });

const VIEWS = [
  { id: 'list', label: '列表' },
  { id: 'month', label: '日历' },
  { id: 'map', label: '地图' },
];
const VIEW_LABELS = VIEWS.map((v) => v.label);
const APPEARANCE_MODES = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'auto', label: '自动' },
];
const APPEARANCE_LABELS = APPEARANCE_MODES.map((m) => m.label);

// 「清理缓存」二级选项：每一项都能单独勾，都是可再生内容
const CACHE_TARGETS = [
  { key: 'thumbs', label: '封面帧（视频缩略图）', note: '列表里的视频封面，删了会按需重建' },
  { key: 'images', label: '图片浏览缓存', note: '看过的图片磁盘缓存，删了会重新加载' },
  { key: 'motion', label: '实况动效临时文件', note: '实况照片提取出来的视频，进后台本来就会清' },
  { key: 'covers', label: '没人引用的封面小图', note: '换封面 / 删记录留下的孤儿文件' },
  { key: 'map', label: '地图缓存（瓦片 + 高德 SDK）', note: '清完下次进地图要重新下载，不想重下就取消勾选' },
];

// 视图切换：
// - iOS：原生 UISegmentedControl（iOS 26+ 自动液态玻璃，原生 UIKit 零延迟触控与滑块拖拽）；
// - Android：白色药丸弹簧过渡。
function ViewSwitcher({ value, onChange }) {
  const { isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [trackWidth, setTrackWidth] = useState(0);
  const idx = Math.max(0, VIEWS.findIndex(v => v.id === value));
  const x = useSharedValue(0);

  useEffect(() => {
    if (!trackWidth) return;
    x.value = withTiming((trackWidth * idx) / VIEWS.length, { duration: 190, easing: Easing.out(Easing.cubic) });
  }, [idx, trackWidth, x]);

  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const segWidth = trackWidth ? trackWidth / VIEWS.length : 0;

  if (hasNativeSegmentedControl) {
    return (
      <NativeSegmentedControl
        segments={VIEW_LABELS}
        selectedIndex={idx}
        isDark={isDark}
        onChange={(nextIdx) => {
          const next = VIEWS[nextIdx];
          if (next) onChange(next.id);
        }}
        style={styles.nativeSegmented}
      />
    );
  }

  // 按下就直接起动画（不等 state 提交后的 effect），高亮才跟手
  const press = (id, i) => {
    if (trackWidth) {
      const to = (trackWidth * i) / VIEWS.length;
      x.value = withTiming(to, { duration: 190, easing: Easing.out(Easing.cubic) });
    }
    onChange(id);
  };

  return (
    <View style={styles.segmentedControl} onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width - 4)}>
      {segWidth > 0 && <Reanimated.View style={[styles.segmentPill, { width: segWidth }, pillStyle]} />}
      {VIEWS.map((v, i) => (
        <TouchableOpacity key={v.id} style={styles.segmentBtn} onPress={() => press(v.id, i)} activeOpacity={0.8}>
          <Text style={[styles.segmentText, value === v.id && styles.segmentTextActive]}>{v.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const {
    logData, syncMedia, importLogs, deleteLog,
    tdtKey, setTdtKey, mapProvider, setMapProvider, amapKey, setAmapKey,
    amapJsKey, setAmapJsKey, amapJsCode, setAmapJsCode, requestBackupSync,
  } = useContext(LogContext);
  // 外观：始终跟随系统（和开屏图保持一致）
  const { colors, isDark, mode, setMode } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const [syncing, setSyncing] = useState(false);
  // 同步进度：显示在底部小条上。以前用 ToastAndroid 报进度，但 Toast 会排队，
  // 最后几条会排在「同步完成」弹窗之后继续弹，看起来像"同步完了还在同步"
  const [syncProgress, setSyncProgress] = useState(null);
  // 侧边栏「说明」：页面上的说明性文字统一收进这里
  const [helpOpen, setHelpOpen] = useState(false);

  // 「我的」昵称与头像：存在本机，并跟随备份导出/导入
  const [profileName, setProfileName] = useState(DEFAULT_PROFILE_NAME);
  const [profileAvatarUri, setProfileAvatarUri] = useState(null);
  const [nameEditorOpen, setNameEditorOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  useEffect(() => {
    let alive = true;
    loadProfile().then((profile) => {
      if (!alive) return;
      setProfileName(profile.name);
      setProfileAvatarUri(profile.avatarUri);
    });
    return () => { alive = false; };
  }, []);

  // 地图服务设置弹窗：天地图 / 高德二选一，两家的 Key 各自保存
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [jsKeyDraft, setJsKeyDraft] = useState('');
  const [jsCodeDraft, setJsCodeDraft] = useState('');
  const [providerDraft, setProviderDraft] = useState(mapProvider);
  const openSettings = () => {
    setProviderDraft(mapProvider);
    setKeyDraft(mapProvider === 'amap' ? amapKey : tdtKey);
    setJsKeyDraft(amapJsKey);
    setJsCodeDraft(amapJsCode);
    setSettingsOpen(true);
  };
  // 切换服务商时把输入框换成对应的 key
  const switchProviderDraft = (next) => {
    setProviderDraft(next);
    setKeyDraft(next === 'amap' ? amapKey : tdtKey);
    if (next === 'amap') {
      setJsKeyDraft(amapJsKey);
      setJsCodeDraft(amapJsCode);
    }
  };
  const saveKey = async () => {
    await setMapProvider(providerDraft);
    if (providerDraft === 'amap') await setAmapKey(keyDraft);
    else await setTdtKey(keyDraft);
    if (providerDraft === 'amap') {
      await setAmapJsKey(jsKeyDraft);
      await setAmapJsCode(jsCodeDraft);
    }
    setSettingsOpen(false);
    hapticSuccess();
    if (Platform.OS === 'android') {
      ToastAndroid.show(
        `${providerDraft === 'amap' ? '高德' : '天地图'}${keyDraft.trim() || jsKeyDraft.trim() ? ' 已保存' : ' Key 已清除'}`,
        ToastAndroid.SHORT
      );
    }
  };

  const commitProfileName = async (raw) => {
    const nextName = String(raw || '').trim() || DEFAULT_PROFILE_NAME;
    setProfileName(nextName);
    setNameEditorOpen(false);
    try {
      await saveProfile({ name: nextName, avatarUri: profileAvatarUri });
      requestBackupSync();
      hapticSuccess();
    } catch {
      Alert.alert('保存失败', '名字已更新，但写入本机时出现问题。');
    }
  };

  const openNameEditor = () => {
    if (Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
      Alert.prompt(
        '修改名字',
        undefined,
        [
          { text: '取消', style: 'cancel' },
          { text: '保存', onPress: (val) => commitProfileName(val) },
        ],
        'plain-text',
        profileName
      );
      return;
    }
    setNameDraft(profileName);
    setNameEditorOpen(true);
  };

  const saveProfileName = () => commitProfileName(nameDraft);

  const pickProfileAvatar = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted && perm.accessPrivileges !== 'limited') {
        Alert.alert('需要相册权限', '允许访问相册后才能选择头像。', [
          { text: '取消', style: 'cancel' },
          { text: '前往设置', onPress: () => Linking.openSettings() },
        ]);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const saved = await persistAvatar(result.assets[0].uri);
      if (!saved) throw new Error('copy failed');
      setProfileAvatarUri(saved);
      await saveProfile({ name: profileName, avatarUri: saved });
      requestBackupSync();
    } catch (e) {
      Alert.alert('头像保存失败', e?.message || '请换一张图片再试。');
    }
  };

  const applyBackupProfile = async (profile) => {
    if (!profile) return false;
    const nextName = profile.name || profileName;
    const nextAvatar = profile.avatarUri || profileAvatarUri;
    setProfileName(nextName);
    setProfileAvatarUri(nextAvatar);
    await saveProfile({ name: nextName, avatarUri: nextAvatar });
    requestBackupSync();
    return true;
  };

  // 相册同步：把断链的影像重新关联到相册原片（升级/换机/重装后的修复入口）
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncProgress(null);
    toggleSidebar(false);
    try {
      const report = await syncMedia((done, total) => setSyncProgress({ done, total }));
      if (report.permissionDenied) {
        const state = report.permState || {};
        Alert.alert(
          '无法同步',
          `需要相册访问权限才能把记录和相册里的原片重新关联，请在系统设置中授权。\n（当前权限状态：granted=${state.granted}, accessPrivileges=${state.accessPrivileges}）`,
          [
            { text: '取消', style: 'cancel' },
            { text: '前往设置', onPress: () => Linking.openSettings() },
          ]
        );
        return;
      }
      const broken = report.unmatched;
      let message;
      if (report.matched > 0) {
        message = `已重新关联 ${report.matched} 张照片。`;
        if (report.freedCopies > 0) {
          message += `\n已清理 ${report.freedCopies} 个本地副本，改用相册原片（为应用释放了存储空间）。`;
        }
        if (broken.length > 0) {
          message += `\n\n仍有 ${broken.length} 条记录无法自动恢复（原片可能已不在相册）：\n${broken.slice(0, 5).map(r => `· ${r.title}`).join('\n')}${broken.length > 5 ? '\n…' : ''}`;
        }
      } else if (broken.length > 0) {
        message = `没有可自动恢复的照片。${broken.length} 条记录的媒体在相册中找不到对应文件，可能需要重新添加：\n${broken.slice(0, 5).map(r => `· ${r.title}`).join('\n')}${broken.length > 5 ? '\n…' : ''}`;
      } else {
        message = '所有照片都能正常显示，无需修复。';
      }
      // 同步顺带清掉的孤儿副本（media/ 里有、记录里没有的影像）：结果一律如实报，
      // 哪怕是 0 条、哪怕读目录失败——不然用户会以为"点了没生效"
      if (report.mediaScanErrors?.length) {
        message += `\n\n⚠️ 副本目录没能全部读到：${report.mediaScanErrors.join('；')}`;
      }
      const freedMB = Math.round((report.freedBytes / 1024 / 1024) * 10) / 10;
      const sizeMB = (b) => (b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${Math.round((b / 1024 / 1024) * 10) / 10} MB`);
      if (report.removedCopies > 0) {
        message += `\n\n已清理 ${report.removedCopies} 个没有记录引用的副本${report.freedBytes > 0 ? `（释放约 ${freedMB} MB）` : ''}。`;
      }
      if (report.removedCovers > 0) {
        message += `\n已清理 ${report.removedCovers} 张没有记录引用的封面小图（${sizeMB(report.freedCoverBytes || 0)}）。`;
      }
      // 没删掉的副本要说明"为什么留着"，否则用户看到的永远是"结果还是有的"
      const left = report.copiesLeft || {};
      const leftBytes = report.copiesLeftBytes || {};
      const leftTotal = (left.referenced || 0) + (left.draft || 0) + (left.fresh || 0) + (left.unreadable || 0);
      if (leftTotal > 0) {
        const why = [];
        if (left.referenced) why.push(`· ${left.referenced} 个（${sizeMB(leftBytes.referenced || 0)}）仍被记录引用：记录存的就是副本、相册里找不到原片，删了记录就没图看；能找到原片的同步时会自动换掉`);
        if (left.draft) why.push(`· ${left.draft} 个（${sizeMB(leftBytes.draft || 0)}）还挂在「添加」页表单里没保存：去那一页删掉或保存后，再同步一次就会清`);
        if (left.fresh) why.push(`· ${left.fresh} 个（${sizeMB(leftBytes.fresh || 0)}）是刚导入不到 5 分钟的，下次同步会再清`);
        if (left.unreadable) why.push(`· ${left.unreadable} 个读不到文件信息（系统限制，不敢删）`);
        message += `\n\n副本目录还剩 ${leftTotal} 个文件：\n${why.join('\n')}`;
        message += '\n数量与大小在「数据目录」里也能看到。';
      } else if (report.removedCopies === 0 && report.removedCovers === 0) {
        message += '\n\n副本目录里没有多余的文件。';
      }
      // 确实没人引用、却删不掉的：说清楚有多少、多大（正常不该出现，出现了就是系统层面拒绝删除）
      const failed = report.failedToDelete;
      if (failed?.count) {
        message += `\n\n⚠️ 有 ${failed.count} 个（${sizeMB(failed.bytes || 0)}）没有记录引用的副本没能删掉`
          + (failed.reasons?.length ? `：${failed.reasons.join('；')}。` : '。');
      }
      // 相册只授权了「部分照片」：没授权那部分原片扫不到，记录会继续用副本显示。
      // 不点破的话用户只会看到"怎么还有副本留着"，所以这里明说怎么办。
      if (report.permState?.accessPrivileges === 'limited') {
        message += '\n\nℹ️ 相册权限是「仅部分照片」：没授权的那部分原片扫不到，'
          + '对应的记录会继续用应用内的副本显示。想清理干净，请在系统设置里把相册权限改成「所有照片」后再同步一次。';
      }
      if (report.failedCovers > 0) {
        message += `\n⚠️ 另有 ${report.failedCovers} 张没有引用的封面小图没能删掉。`;
      }
      Alert.alert('同步完成', message);
    } catch (e) {
      console.error('同步相册失败', e);
      Alert.alert('同步失败', `扫描相册时出现问题：${e?.message || e}`);
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  };

  // 备份导出：把全部记录写成 JSON 文件到用户选的文件夹
  const handleExportBackup = async () => {
    toggleSidebar(false);
    const result = await exportBackup(
      logData,
      { tdtKey, mapProvider, amapKey, amapJsKey, amapJsCode },
      { name: profileName, avatarUri: profileAvatarUri }
    );
    if (result.canceled) return;
    if (result.ok) {
      Alert.alert(
        '导出成功',
        `已备份 ${result.count} 条记录${result.covers ? `、${result.covers} 张封面文件` : ''}${result.videoPosters ? `、${result.videoPosters} 张视频封面` : ''}${result.keys ? '、地图 Key' : ''}${result.profile ? '、头像与名字' : ''}：\n${result.name}`
      );
    } else {
      Alert.alert('导出失败', result.error || '写入备份文件时出现问题，请稍后再试。');
    }
  };

  // 备份里的地图 Key 一并恢复（Key 是整机设置，不挂在记录上）
  const applyBackupKeys = (keys) => {
    if (!keys) return false;
    let applied = false;
    if (typeof keys.tdtKey === 'string') { setTdtKey(keys.tdtKey); applied = true; }
    if (keys.mapProvider === 'amap' || keys.mapProvider === 'tianditu') { setMapProvider(keys.mapProvider); applied = true; }
    if (typeof keys.amapKey === 'string') { setAmapKey(keys.amapKey); applied = true; }
    if (typeof keys.amapJsKey === 'string') { setAmapJsKey(keys.amapJsKey); applied = true; }
    if (typeof keys.amapJsCode === 'string') { setAmapJsCode(keys.amapJsCode); applied = true; }
    return applied;
  };

  // 数据目录：看副本/封面实际落在哪、各有多少（含"为什么还留着"的明细），并现场做一次写入测试。
  // 如果副本是被「添加」页草稿占着（那是个常驻 tab，放弃的分享副本会一直留着），
  // 这里给一个"清空草稿"的出口：清完立刻扫一遍副本目录，能删的就地删掉。
  const handleShowStorage = async () => {
    toggleSidebar(false);
    try {
      const storage = await describeStorageAsync();
      const copies = await describeMediaCopiesAsync(logData).catch(() => null);
      const buttons = [{ text: '关闭', style: 'cancel' }];
      if (copies?.draft) {
        buttons.unshift({
          text: '清空添加页草稿',
          onPress: async () => {
            requestAddDraftReset();
            const pruned = await pruneOrphanMediaCopies(logData).catch(() => ({ removed: 0 }));
            const mb = Math.round((pruned.freed || 0) / 1024 / 1024 * 10) / 10;
            Alert.alert('已清空草稿', pruned.removed
              ? `「添加」页里没保存的照片已清掉，并释放了 ${mb} MB（${pruned.removed} 个副本）。`
              : '「添加」页里没保存的照片已清掉。');
          },
        });
      }
      Alert.alert('数据目录', [storage, copies?.text].filter(Boolean).join('\n\n'), buttons);
    } catch (e) {
      Alert.alert('数据目录', e?.message || '读取目录信息失败');
    }
  };

  // 备份导入：文件选择器直接选一份备份 JSON → 确认覆盖/合并 → 导入后引导同步相册重新关联影像
  const doImport = async (logs, mode, coversRestored, postersRestored, keys, profile) => {
    const report = await importLogs(logs, mode);
    const keysRestored = applyBackupKeys(keys);
    const profileRestored = await applyBackupProfile(profile);
    Alert.alert(
      '导入完成',
      (mode === 'replace'
        ? `已覆盖恢复，当前共 ${report.total} 条记录。`
        : `已合并导入：新增 ${report.added} 条、更新 ${report.updated} 条，当前共 ${report.total} 条。`)
        + (coversRestored ? `\n已恢复 ${coversRestored} 张封面文件。` : '')
        + (postersRestored ? `\n已恢复 ${postersRestored} 张视频封面。` : '')
        + (keysRestored ? '\n已恢复备份里的地图 Key。' : '')
        + (profileRestored ? '\n已恢复头像与名字。' : ''),
      [
        { text: '稍后', style: 'cancel' },
        { text: '立即同步', onPress: handleSync },
      ]
    );
  };

  const handleImportBackup = async () => {
    toggleSidebar(false);
    const result = await importBackup();
    if (result.canceled) return;
    if (!result.ok) {
      const message = result.invalid
        ? '所选文件不是本应用导出的备份，或内容已损坏。'
        : (result.error || '读取备份文件时出现问题，请稍后再试。');
      Alert.alert('导入失败', message);
      return;
    }
    const exportedAt = result.exportedAt ? `\n导出时间：${result.exportedAt.replace('T', ' ').slice(0, 16)}` : '';
    const summary = `备份文件：${result.name}\n包含 ${result.count} 条记录${result.profile ? '、头像与名字' : ''}${exportedAt}\n当前有 ${logData.length} 条记录。`;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: '导入备份',
          message: summary,
          options: ['合并去重', '覆盖现有', '取消'],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) doImport(result.logs, 'merge', result.coversRestored, result.postersRestored, result.keys, result.profile);
          else if (buttonIndex === 1) doImport(result.logs, 'replace', result.coversRestored, result.postersRestored, result.keys, result.profile);
        }
      );
      return;
    }
    Alert.alert(
      '导入备份',
      `${summary}\n\n选择导入方式：`,
      [
        { text: '取消', style: 'cancel' },
        { text: '覆盖现有', style: 'destructive', onPress: () => doImport(result.logs, 'replace', result.coversRestored, result.postersRestored, result.keys, result.profile) },
        { text: '合并去重', onPress: () => doImport(result.logs, 'merge', result.coversRestored, result.postersRestored, result.keys, result.profile) },
      ]
    );
  };
  
  /* 清理缓存：先弹二级选项，让用户挑清哪些（都是可再生内容，清了不影响记录）。
     地图缓存和别的缓存共用一个 WebView 的 HTTP 缓存（瓦片 + 高德 SDK + 矢量数据），
     所以它单独一项、默认勾上——不想让下次进地图重新下 SDK 就取消它。 */
  const [cachePickerOpen, setCachePickerOpen] = useState(false);
  const [cacheTargets, setCacheTargets] = useState({ thumbs: true, images: true, motion: true, covers: true, map: true });

  const handleCleanCache = () => {
    toggleSidebar(false);
    setCachePickerOpen(true);
  };

  const runCleanCache = async () => {
    const t = cacheTargets;
    if (!t.thumbs && !t.images && !t.motion && !t.covers && !t.map) {
      Alert.alert('清理缓存', '一项都没选。');
      return;
    }
    setCachePickerOpen(false);
    try {
      const res = await cleanupMediaCaches(logData, {
        thumbs: t.thumbs, images: t.images, motion: t.motion, covers: t.covers,
      });
      // 实况提取目录刚被清空，内存里"已就绪"的地址也要一起作废，不然会指向不存在的文件
      if (t.motion) clearMotionVideoCache();
      if (t.map) {
        try {
          // Android 走 WebView.clearCache(true)；iOS 走原生 WKWebsiteDataStore 清理磁盘/内存缓存
          if (Platform.OS === 'ios') await clearWebKitCacheAsync();
          else mapRef.current?.clearCache?.(true);
        } catch {}
      }
      const mb = Math.round((res.freed / 1024 / 1024) * 10) / 10;
      const parts = [];
      if (t.thumbs || t.images || t.motion) parts.push('缓存');
      if (t.covers && res.covers) parts.push(`没人引用的封面小图 ${res.covers} 张`);
      Alert.alert('清理完成',
        `已释放 ${mb} MB 空间${parts.length ? `（${parts.join(' + ')}）` : ''}。`
        + (t.map ? '\n地图缓存（瓦片 + 高德 SDK）也清空了，下次进地图会重新下载。' : ''));
    } catch (e) {
      Alert.alert('清理失败', e?.message || '清理缓存时出现问题，请稍后再试。');
    }
  };

  const [viewMode, setViewMode] = useState('list'); 
  const [pillMode, setPillMode] = useState('list');   // 药丸的选中态，跟手一点
  const pendingView = useRef(null);                   // 最近一次点击的目标视图
  const [mapMounted, setMapMounted] = useState(false); // 首次进地图才挂 WebView，之后一直保活
  const mapRef = useRef(null);

  useEffect(() => {
    if (viewMode !== 'map') return undefined;
    const timer = setTimeout(() => {
      // 地图页刚从 display:none 切回来：容器尺寸变了，需要让 Leaflet 重新量一次
      // 延迟到切换动画（约 300ms）之后再量，避免和药丸动画抢主线程
      mapRef.current?.injectJavaScript('window.__rcMap && window.__rcMap.markDirty(); true;');
    }, 320);
    return () => clearTimeout(timer);
  }, [viewMode]);

  /* ---------------- 地图全屏（横屏） ----------------
     两点原则：
     ① 只让「地图」横过来，不转整个界面：窗口始终是竖屏（app.json 也是 portrait），
        全屏时把地图这块内容绕中心转 90°，宽高互换铺满整屏——转手机看就是横屏地图，
        列表/日历/添加/详情的排版完全不受影响，也不会出现系统转屏那一套回调；
     ② 全屏不是换一个 WebView：地图层原地变大（WebView 不重建 → 瓦片、视角、
        已经打开的卡片都保住）。

     位置怎么摆：地图层是**根容器的直接子节点**，两种状态都写绝对坐标——
       · 平时：量出 viewArea 相对根容器的矩形，再按列表卡片那圈边距（16/4/20）缩进；
       · 全屏：直接 { 0, 0, 根容器宽高 }。
     不塞进 viewArea 里（早期写法是塞进去再用负偏移往外撑），是因为那样坐标要绕一层
     父容器、符号极易写反，还要担心父容器裁剪；挂在根容器下，"整屏"就是 { 0, 0, 整屏 }，
     不用换算。 */
  const [mapFullscreen, setMapFullscreen] = useState(false);
  // 地图层挂在「根容器」下面（不是塞在列表那块 viewArea 里）：
  //   · 平时靠测量把自己摆到 viewArea 的位置上；
  //   · 全屏时直接摆成"整屏"，于是它的 bounds 就是整屏——不光是看得全，
  //     触摸也才收得到（父容器不覆盖的地方，手指点下去根本传不到地图）。
  //   （1.7.4 早期版本塞在 viewArea 里、用父容器坐标系写负偏移，top 的符号写反了，
  //    地图被整体往下推了"头部+标题"的高度，表现就是"只有下半部分是地图、
  //    上半部分还是主界面"。现在改成根容器坐标系，不存在这种换算。）
  const [mapRect, setMapRect] = useState(null);    // { left, top, width, height }（相对根容器）
  const [rootSize, setRootSize] = useState(null);  // 根容器尺寸（全屏时用）
  const rootRef = useRef(null);
  const viewAreaRef = useRef(null);
  const { width: winW, height: winH } = useWindowDimensions();

  const measureRect = useCallback((ref) => new Promise((resolve) => {
    const node = ref.current;
    if (!node || typeof node.measureInWindow !== 'function') { resolve(null); return; }
    node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  }), []);

  // 同一时刻量「根容器」和「地图占位区」两个矩形，差值就是地图层该摆的位置
  const measureMapRect = useCallback(() => {
    Promise.all([measureRect(rootRef), measureRect(viewAreaRef)]).then(([root, area]) => {
      if (!root || !area) return;
      setRootSize((prev) => (prev && prev.w === root.width && prev.h === root.height ? prev : { w: root.width, h: root.height }));
      const next = { left: area.x - root.x, top: area.y - root.y, width: area.width, height: area.height };
      setMapRect((prev) => (
        prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height
          ? prev : next
      ));
    });
  }, [measureRect]);

  // 首帧 / 进入地图 / 隐藏 TabBar / 窗口尺寸变化都要重新量，多补几拍最稳
  useEffect(() => {
    const timers = [0, 120, 400].map((delay) => setTimeout(measureMapRect, delay));
    return () => timers.forEach(clearTimeout);
  }, [measureMapRect, winW, winH, mapFullscreen, viewMode]);

  // 尺寸变了要让地图重新量一次容器：全屏、退出、窗口尺寸变化各补一次
  useEffect(() => {
    const sync = () => mapRef.current?.injectJavaScript(
      `window.__rcMap && window.__rcMap.setFullscreen(${mapFullscreen ? 'true' : 'false'}); true;`
    );
    sync();
    const timers = [260, 620].map((delay) => setTimeout(sync, delay));
    return () => timers.forEach(clearTimeout);
  }, [mapFullscreen, winW, winH]);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [mapIsDark, setMapIsDark] = useState(isDark);
  const sidebarAnim = useRef(new Animated.Value(-SIDEBAR_WIDTH)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;

  // 主题切换时不要立刻重建 WebView 里的地图：地图在背景层保活，
  // 每次切深浅都会重载瓦片和渲染器，关闭「我的」后再同步地图主题更稳。
  useEffect(() => {
    if (!isSidebarOpen) setMapIsDark(isDark);
  }, [isDark, isSidebarOpen]);
  const mapPalette = useMemo(
    () => getPalette(mapIsDark ? 'dark' : 'light'),
    [mapIsDark]
  );

  const toggleSidebar = useCallback((open) => {
    setIsSidebarOpen(open);
    navigation.setOptions({ tabBarStyle: open ? HIDDEN_TAB_BAR : tabBarStyleFor(colors) });
    // 打开侧边栏先收键盘：列表搜索框还聚焦着的时候，键盘会盖住侧边栏下半部分，
    // 那几项（导出备份 / 导入备份 / 清理缓存 / 说明…）点了就像没反应，得点好几次
    if (open) Keyboard.dismiss();
    Animated.spring(sidebarAnim,
      {
        toValue: open ? 0 : -SIDEBAR_WIDTH,
        useNativeDriver: true,
        stiffness: 230,  // 更硬：弹出更快，点了马上有反馈
        damping: 24,     // 阻尼跟着加，避免快到末端时抖
        mass: 0.7        // 更轻：整体更跟手
      }
    ).start();
    Animated.timing(overlayAnim, { toValue: open ? 1 : 0, duration: 150, useNativeDriver: true }).start();
  }, [sidebarAnim, overlayAnim, navigation, colors]);

  // 进 / 退全屏：地图铺满整屏并横过来（转内容，不转界面）。
  // 底部 TabBar 也要藏起来/装回去，不然全屏地图底部会露出一条 TabBar
  const enterMapFullscreen = useCallback(() => {
    toggleSidebar(false);
    navigation.setOptions({ tabBarStyle: HIDDEN_TAB_BAR });
    // 先用当前窗口尺寸给一个初值，随后测量再校正（避免第一帧还是竖的）
    const win = Dimensions.get('window');
    setRootSize((prev) => prev || { w: win.width, h: win.height });
    setMapFullscreen(true);
  }, [navigation, toggleSidebar]);
  const exitMapFullscreen = useCallback(() => {
    setMapFullscreen(false);
    navigation.setOptions({ tabBarStyle: tabBarStyleFor(colors) });
  }, [navigation, colors]);

  // 兜底：万一首页被卸载时还停在全屏，别把 TabBar 永久留在隐藏状态
  const fullscreenRef = useRef(false);
  const tabBarStyleRef = useRef(tabBarStyleFor(colors));
  useEffect(() => { fullscreenRef.current = mapFullscreen; }, [mapFullscreen]);
  useEffect(() => { tabBarStyleRef.current = tabBarStyleFor(colors); }, [colors]);
  useEffect(() => () => {
    if (fullscreenRef.current) navigation.setOptions({ tabBarStyle: tabBarStyleRef.current });
  }, [navigation]);

  // 地图上的「查看详情」：窗口本来就是竖屏、地图只是内容转了 90°，
  // 所以直接跳转即可（不用退全屏、不用等转屏），返回时地图仍是刚才的全屏状态。
  const openDetailFromMap = useCallback((item) => {
    if (!item) return;
    const parent = navigation.getParent?.();
    if (parent?.push) parent.push('Detail', { item });
    else navigation.navigate('Detail', { item });
  }, [navigation]);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState([]);
  const filterSheetRef = useRef(null);
  const snapPoints = useMemo(() => ['60%', '85%'], []);
  const lastBackRef = useRef(0);
  const [sheetOpen, setSheetOpen] = useState(false);

  // 返回策略：主界面按一次返回提示"再按一次退出"，2 秒内再按退出；
  // 筛选面板打开时先关面板；二级页面在上面时（首页未聚焦）不拦截
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigation.isFocused()) return false;
      // 地图还在全屏（横屏）：先退全屏，不要直接提示退出应用
      if (mapFullscreen) {
        exitMapFullscreen();
        return true;
      }
      if (isSidebarOpen) {
        toggleSidebar(false);
        return true;
      }
      if (sheetOpen) {
        filterSheetRef.current?.dismiss();
        return true;
      }
      const now = Date.now();
      if (now - lastBackRef.current < 2000) {
        BackHandler.exitApp();
        return true;
      }
      lastBackRef.current = now;
      ToastAndroid.show('再按一次退出应用', ToastAndroid.SHORT);
      return true;
    });
    return () => sub.remove();
  }, [navigation, sheetOpen, mapFullscreen, exitMapFullscreen, isSidebarOpen, toggleSidebar]);

  const renderBackdrop = useCallback(
    (props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />, []
  );

  // 日历 / 地图使用全量数据；列表的搜索与筛选只影响列表本身
  const sortedData = useMemo(
    () => [...logData].sort((a, b) => new Date(b.date) - new Date(a.date)),
    [logData]
  );

  const filteredAndSortedData = useMemo(() => {
    let result = [...sortedData];
    if (searchQuery.trim().length > 0) {
      const lowerQuery = searchQuery.toLowerCase();
      result = result.filter(item => (item.title && item.title.toLowerCase().includes(lowerQuery)) || (item.subtitle && item.subtitle.toLowerCase().includes(lowerQuery)) || (item.comment && item.comment.toLowerCase().includes(lowerQuery)));
    }
    if (activeFilters.length > 0) {
      result = result.filter(item => activeFilters.includes(item.subType) || activeFilters.includes(item.baseType));
    }
    return result;
  }, [sortedData, activeFilters, searchQuery]);

  const profileStats = useMemo(() => ({
    records: logData.length,
    images: logData.reduce((sum, item) => sum + (item.localImages?.length || 0), 0),
    places: logData.filter((item) => item.baseType === 'location').length,
  }), [logData]);

  // 同名地点的落点：地点印记和旅票的出发地/目的地一起算（规则见 utils/mapPlaces.js）。
  // 用全量 logData 算，切换筛选时同一地点的位置不会跳
  const placeAnchors = useMemo(() => buildPlaceAnchors(logData), [logData]);

  // 地图数据：打点（地点坐标 / 旅票起终点）+ 轨迹段（出发地→目的地聚合）
  const mapData = useMemo(() => {
    // 同名地点先归到统一的落点上（见 placeAnchors），拿到名字就优先用它
    const anchorFor = (name, at) => anchorOf(placeAnchors, name, at);
    // 打点：地点用 coordinates；旅票用 start/end（坐标缺失的记录跳过）
    const points = [];
    sortedData.forEach(item => {
      const note = item.comment || item.subtitle || '';
      const location = latLngOfPoint(item.coordinates);
      if (location) {
        const at = anchorFor(item.title, location);
        points.push({ id: item.id, kind: 'location', title: item.title, date: item.date, note, lat: at.lat, lng: at.lng });
      }
      [item.start, item.end].forEach(p => {
        const at = anchorFor(p?.name, latLngOfPoint(p));
        if (at) {
          points.push({ id: item.id, kind: 'ticket', subType: item.subType, title: shortPlaceName(p.name || item.title), date: item.date, note, lat: at.lat, lng: at.lng });
        }
      });
    });
    // 轨迹段：按 出发地→目的地 聚合（单向），往返分居弧线两侧，粗细 = 次数。
    // 分段键用（归位后的）坐标而不是名称：同一段被改成不同别名后仍算同一条线；
    // 两端坐标都用同名落点，弧线才会正好连到针上（同名不同坐标的两条也不再多画一段）
    const segMap = new Map();
    sortedData
      .filter(item => item.baseType === 'ticket' && latLngOfPoint(item.start) && latLngOfPoint(item.end))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .forEach(t => {
        const fromAt = anchorFor(t.start?.name, latLngOfPoint(t.start));
        const toAt = anchorFor(t.end?.name, latLngOfPoint(t.end));
        const from = { name: t.start?.name || '', longitude: fromAt.lng, latitude: fromAt.lat };
        const to = { name: t.end?.name || '', longitude: toAt.lng, latitude: toAt.lat };
        const key = [from, to].map(p => p.longitude.toFixed(4) + ',' + p.latitude.toFixed(4)).join('→');
        if (!segMap.has(key)) segMap.set(key, { from, to, count: 0, subType: t.subType });
        const seg = segMap.get(key);
        seg.count++;
        seg.from = from; seg.to = to;   // 显示名称取最近一次的别名
      });
    const segs = [...segMap.values()];
    return { points, segs };
  }, [sortedData, placeAnchors]);

  // 矢量渲染（高德官方 JS API 2.0）只在「高德 + 填了 Web端(JS API) key」时启用；
  // 一旦 JS API 没能出图就自动切回栅格底图，改 key / 换服务商会重新试一次
  const [jsApiFailed, setJsApiFailed] = useState(false);
  const useJsApi = mapProvider === 'amap' && !!amapJsKey.trim() && !jsApiFailed;
  useEffect(() => { setJsApiFailed(false); }, [amapJsKey, amapJsCode, mapProvider]);

  // 地图 HTML：栅格模式内联本地 Leaflet，矢量模式加载高德官方 SDK；
  // 主题色 / 深浅色切换时只重建这一份字符串
  const mapHtml = useMemo(() => buildMapHtml({
    points: mapData.points,
    segs: mapData.segs,
    tdtKey,
    provider: mapProvider,
    jsApiKey: useJsApi ? amapJsKey : '',
    securityCode: useJsApi ? amapJsCode : '',
    dark: mapIsDark,
    notice: jsApiFailed ? '高德 JS API 没能出图，已切回栅格底图（检查 JS API Key / 安全密钥 / 网络）' : '',
    colors: mapPalette.map,
    // 矢量模式不注入 Leaflet：省掉 145KB 的内联脚本，也少一份用不上的库
    leafletJs: useJsApi ? '' : LEAFLET_JS,
    leafletCss: useJsApi ? '' : LEAFLET_CSS,
  }), [mapData, tdtKey, mapProvider, amapJsKey, amapJsCode, useJsApi, mapIsDark, jsApiFailed, mapPalette.map]);
  // source 对象要 memo：否则每次 HomeScreen 重渲染（滑动侧边栏、打字搜索…）
  // 都会给 WebView 换一个新对象，WebView 把整张地图连同瓦片重新加载一遍
  // baseUrl 给页面一个正经的 https 源：高德 JS API 会往 vdata.amap.com 发跨域请求，
  // about:blank（源为 null）在某些版本上会被拦
  const mapSource = useMemo(() => ({ html: mapHtml, baseUrl: 'https://localhost/' }), [mapHtml]);


  // push 而不是 navigate：navigate 遇到栈里已有的 Detail 可能直接复用，
  // 表现就是有的记录有滑入动画、有的没有。Home 在 Tab 里，push 要从父级 Stack 拿。
  const openDetail = useCallback((item) => {
    if (!item) return;
    const parent = navigation.getParent?.();
    if (parent?.push) parent.push('Detail', { item });
    else navigation.navigate('Detail', { item });
  }, [navigation]);
  const editItem = useCallback((item) => navigation.navigate('Edit', { editItem: item }), [navigation]);
  // 上下文里的 deleteLog 每次 Provider 重渲染都会换新函数；用 ref 包一层保持引用稳定，
  // 这样 React.memo 的行组件不会因为"父级随便重渲染一次"就整屏跟着重渲染
  const deleteLogRef = useRef(deleteLog);
  deleteLogRef.current = deleteLog;
  const handleDeleteItem = useCallback((id) => deleteLogRef.current?.(id), []);

  const renderItem = useCallback(({ item, index }) => (
    <RecordRow
      item={item}
      isLast={index === filteredAndSortedData.length - 1}
      onPress={openDetail}
      onEdit={editItem}
      onDelete={handleDeleteItem}
    />
  ), [filteredAndSortedData.length, openDetail, editItem, handleDeleteItem]);

  // 切视图时给内容一个很短的淡入上浮，避免"啪"一下换掉
  const viewAnim = useSharedValue(1);
  useEffect(() => {
    viewAnim.value = 0;
    viewAnim.value = withTiming(1, { duration: 220 });
  }, [viewMode, viewAnim]);
  const viewFadeStyle = useAnimatedStyle(() => ({
    opacity: viewAnim.value,
    transform: [{ translateY: (1 - viewAnim.value) * 8 }],
  }));

  // 切换视图：药丸立刻跟手；地图出场要重新布局（WebView 从 0 尺寸变回有尺寸），
  // 所以让它晚一拍再显示，避免和切换动画抢主线程
  const changeView = useCallback((id) => {
    if (pendingView.current === id) return;
    pendingView.current = id;
    setPillMode(id);
    if (id === 'map') setMapMounted(true);
    setViewMode(id);
  }, []);

  // 地图层常驻，所以它的透明度必须由一个"永远挂着的"动画样式控制：
  // 之前把 viewFadeStyle 从数组里摘掉，Reanimated 留在原生视图上的 opacity=1 不会复位，
  // 于是切回列表/日历后地图还浮在最上面。
  const mapFade = useSharedValue(0);
  useEffect(() => {
    // 这里不做动画：地图是 WebView，逐帧改透明度要重新合成整层，
    // 会和导航条高亮的滑动抢帧（就是"切地图时状态条卡一下"）。直接切换，
    // 地图本来就是常驻渲染好的，瞬间出现即可。
    mapFade.value = viewMode === 'map' ? 1 : 0;
  }, [viewMode, mapFade]);
  const mapLayerStyle = useAnimatedStyle(() => ({
    opacity: mapFade.value,
    transform: [{ translateY: (1 - mapFade.value) * 8 }],
  }));

  /* 全屏时地图「横过来」的几何：
     · 舞台：边长 = max(屏宽, 屏高) 的正方形，摆在地图层正中间；
     · 地图：宽高互换（宽 = 屏高、高 = 屏宽），摆进舞台正中间后绕中心转 90°。
     为什么要多这一层舞台：Android 的 clipChildren 是按子视图的**布局框**裁的，
     如果直接把"布局框比屏幕还大"的旋转层放在地图层里，会被裁成一条横带
     ——之前"只有下半部分是地图、上半部分还是主界面"就是这么来的。
     放进舞台后，布局框和旋转后的实际范围都装得下，谁也不裁它。 */
  const mapStageBox = useMemo(() => {
    if (!mapFullscreen || !rootSize) return null;
    const { w, h } = rootSize;
    const s = Math.max(w, h);
    return { left: (w - s) / 2, top: (h - s) / 2, width: s, height: s };
  }, [mapFullscreen, rootSize]);

  const mapBoxRotated = useMemo(() => {
    if (!mapFullscreen || !rootSize) return null;
    const { w, h } = rootSize;
    const s = Math.max(w, h);
    return {
      position: 'absolute',
      width: h,
      height: w,
      left: (s - h) / 2,
      top: (s - w) / 2,
      transform: [{ rotate: '90deg' }],
    };
  }, [mapFullscreen, rootSize]);

  // 地图层的位置：全屏 = 整屏；平时 = 量出来的 viewArea 位置（再收进列表卡片那圈边距，
  // 和列表/日历的圆角卡片对齐）。还没量到时给一个近似位置兜底，免得 WebView 挂不上。
  const mapLayerBox = useMemo(() => {
    if (mapFullscreen) {
      // 取「根容器」和「窗口」里更大的那个：万一 TabBar 的 display:none 没把高度还回来，
      // 地图也要盖满整个窗口（根容器更小的话，多出来的部分由下层容器裁，不会露出背景）
      const w = Math.max(rootSize?.w || 0, winW);
      const h = Math.max(rootSize?.h || 0, winH);
      return { left: 0, top: 0, width: w, height: h };
    }
    const base = mapRect || {
      left: 0,
      top: insets.top + 110,
      width: winW,
      height: Math.max(0, winH - insets.top - 110 - 20),
    };
    return {
      left: base.left + 16,
      top: base.top + 4,
      width: Math.max(0, base.width - 32),
      height: Math.max(0, base.height - 24),
    };
  }, [mapFullscreen, rootSize, winW, winH, insets.top, mapRect]);

  // 地图 WebView 只在用户真正切到「地图」时才挂（挂载后保活）。
  // 之前是启动 1.2 秒就预挂：没进过地图的人，在列表/日历里滚动时也一直在
  // 为一个常驻 WebView 做合成（掉帧的主要来源）。懒挂之后，列表/日历的滚动
  // 完全不经过 WebView；第一次点地图只多一次建页，之后照旧保活。
  useEffect(() => {
    if (viewMode === 'map') setMapMounted(true);
  }, [viewMode]);

  return (
    <View style={styles.container} ref={rootRef} collapsable={false}>
      {/* 地图全屏时把状态栏也收起来，才是真正的整屏 */}
      <StatusBar hidden={mapFullscreen} />

      {isSidebarOpen && (
        <Animated.View style={[styles.sidebarOverlay, { opacity: overlayAnim }]}>
          <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={() => toggleSidebar(false)} />
        </Animated.View>
      )}
      <Animated.View
        pointerEvents={isSidebarOpen ? 'auto' : 'none'}
        style={[styles.sidebar, { transform: [{ translateX: sidebarAnim }] }]}
      >
        <View style={[styles.sidebarContent, { paddingTop: insets.top + 8 }]}>
          <View style={styles.profileTopbar}>
            <View style={styles.profileBackWrap}>
              <LiquidGlassSurface cornerRadius={19} isDark={isDark} interactive />
              <TouchableOpacity
                style={styles.profileBack}
                onPress={() => toggleSidebar(false)}
                delayPressIn={0}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <NativeIcon name="chevron.left" fallback={ChevronLeft} size={20} color={colors.text} weight="semibold" />
              </TouchableOpacity>
            </View>
            <Text style={styles.profileTopTitle}>我的</Text>
            <View style={{ width: 38 }} />
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={Platform.OS === 'ios'}
            overScrollMode="never"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[styles.profileScrollContent, { paddingBottom: Math.max(32, insets.bottom + 24) }]}
          >
            <View style={styles.profileCard}>
              <View style={styles.profileIdentity}>
                <TouchableOpacity style={styles.profileAvatar} onPress={pickProfileAvatar} activeOpacity={0.82} delayPressIn={0}>
                  {profileAvatarUri ? (
                    <Image source={{ uri: profileAvatarUri }} style={styles.profileAvatarImage} contentFit="cover" />
                  ) : (
                    <NativeIcon name="person.fill" fallback={User} size={28} color={colors.textOnAccent} />
                  )}
                  <View style={styles.avatarEditBadge}>
                    <NativeIcon name="pencil" fallback={Pencil} size={10} color="#FFF" weight="bold" />
                  </View>
                </TouchableOpacity>
                <View style={styles.profileCopy}>
                  <TouchableOpacity style={styles.profileNameRow} onPress={openNameEditor} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}>
                    <Text style={styles.profileName} numberOfLines={1}>{profileName}</Text>
                    <NativeIcon name="pencil" fallback={Pencil} size={14} color={colors.textMuted} />
                  </TouchableOpacity>
                  <Text style={styles.profileSub}>点头像更换照片，点名字修改昵称</Text>
                </View>
              </View>
              <View style={styles.profileStats}>
                <View style={styles.profileStat}>
                  <Text style={styles.profileStatNum}>{profileStats.records}</Text>
                  <Text style={styles.profileStatLabel}>印记</Text>
                </View>
                <View style={styles.profileStat}>
                  <Text style={styles.profileStatNum}>{profileStats.images}</Text>
                  <Text style={styles.profileStatLabel}>影像</Text>
                </View>
                <View style={[styles.profileStat, styles.profileStatLast]}>
                  <Text style={styles.profileStatNum}>{profileStats.places}</Text>
                  <Text style={styles.profileStatLabel}>地点</Text>
                </View>
              </View>
            </View>

            <Text style={styles.groupLabel}>外观</Text>
            <View style={styles.appearanceCard}>
              {hasNativeSegmentedControl ? (
                <View style={styles.appearanceNativeRow}>
                  <Text style={styles.appearanceNativeLabel}>显示模式</Text>
                  <NativeSegmentedControl
                    segments={APPEARANCE_LABELS}
                    selectedIndex={Math.max(0, APPEARANCE_MODES.findIndex((o) => o.id === mode))}
                    isDark={isDark}
                    onChange={(idx) => {
                      const next = APPEARANCE_MODES[idx];
                      if (next) {
                        hapticSelection();
                        setMode(next.id);
                      }
                    }}
                    style={styles.appearanceNativeSeg}
                  />
                </View>
              ) : (
                <View style={styles.appearanceOptions}>
                  {APPEARANCE_MODES.map((option) => {
                    const on = mode === option.id;
                    return (
                      <TouchableOpacity
                        key={option.id}
                        style={[styles.appearanceOption, on && styles.appearanceOptionOn]}
                        onPress={() => { hapticSelection(); setMode(option.id); }}
                        activeOpacity={0.75}
                        delayPressIn={0}
                        accessibilityRole="button"
                      >
                        <Text style={[styles.appearanceOptionText, on && styles.appearanceOptionTextOn]}>{option.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>

            <Text style={styles.groupLabel}>记录与同步</Text>
            <View style={styles.menuCard}>
              <TouchableOpacity style={styles.menuItem} onPress={openSettings} delayPressIn={0} activeOpacity={0.65}>
                <View style={[styles.menuIconBox, { backgroundColor: colors.iconTicket }]}>
                  <NativeIcon name="gearshape.fill" fallback={Settings} size={17} color={colors.accent} />
                </View>
                <View style={styles.menuCopy}>
                  <Text style={styles.menuItemText}>地图服务</Text>
                  <Text style={styles.menuItemSub} numberOfLines={1}>
                    {mapProvider === 'amap'
                      ? `高德 · ${amapJsKey ? '矢量渲染' : '栅格底图'}${amapKey ? ' · 已配检索' : ''}`
                      : (tdtKey ? '天地图已配置' : '天地图未配置')}
                  </Text>
                </View>
                <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />
              </TouchableOpacity>
              <View style={styles.menuInsetDivider} />
              <TouchableOpacity style={styles.menuItem} onPress={handleSync} disabled={syncing} delayPressIn={0} activeOpacity={0.65}>
                <View style={[styles.menuIconBox, { backgroundColor: colors.groupNoteSoft }]}>
                  <NativeIcon name="arrow.triangle.2.circlepath" fallback={RefreshCw} size={16} color={colors.groupNote} />
                </View>
                <View style={styles.menuCopy}>
                  <Text style={styles.menuItemText}>{syncing ? '正在同步…' : '同步相册照片'}</Text>
                  <Text style={styles.menuItemSub}>重新关联相册原片并清理孤儿副本</Text>
                </View>
                <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />
              </TouchableOpacity>
              <View style={styles.menuInsetDivider} />
              <TouchableOpacity style={styles.menuItem} onPress={handleExportBackup} delayPressIn={0} activeOpacity={0.65}>
                <View style={[styles.menuIconBox, { backgroundColor: colors.iconTrip }]}>
                  <NativeIcon name="square.and.arrow.up" fallback={Upload} size={17} color={colors.orange} />
                </View>
                <View style={styles.menuCopy}>
                  <Text style={styles.menuItemText}>导出备份</Text>
                  <Text style={styles.menuItemSub}>全部记录、封面与地图配置</Text>
                </View>
                <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />
              </TouchableOpacity>
              <View style={styles.menuInsetDivider} />
              <TouchableOpacity style={styles.menuItem} onPress={handleImportBackup} delayPressIn={0} activeOpacity={0.65}>
                <View style={[styles.menuIconBox, { backgroundColor: colors.iconTicket }]}>
                  <NativeIcon name="square.and.arrow.down" fallback={Download} size={17} color={colors.accent} />
                </View>
                <View style={styles.menuCopy}>
                  <Text style={styles.menuItemText}>导入备份</Text>
                  <Text style={styles.menuItemSub}>合并去重或覆盖恢复本地记录</Text>
                </View>
                <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />
              </TouchableOpacity>
            </View>

            <Text style={styles.groupLabel}>存储与帮助</Text>
            <View style={styles.menuCard}>
              <TouchableOpacity style={styles.menuItem} onPress={handleCleanCache} delayPressIn={0} activeOpacity={0.65}>
                <View style={[styles.menuIconBox, { backgroundColor: colors.fill }]}>
                  <NativeIcon name="trash" fallback={Eraser} size={16} color={colors.textSecondary} />
                </View>
                <View style={styles.menuCopy}>
                  <Text style={styles.menuItemText}>清理缓存</Text>
                  <Text style={styles.menuItemSub}>封面帧、图片与地图缓存</Text>
                </View>
                <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />
              </TouchableOpacity>
              <View style={styles.menuInsetDivider} />
              <TouchableOpacity style={styles.menuItem} onPress={handleShowStorage} delayPressIn={0} activeOpacity={0.65}>
                <View style={[styles.menuIconBox, { backgroundColor: colors.fill }]}>
                  <NativeIcon name="folder" fallback={FolderOpen} size={16} color={colors.textSecondary} />
                </View>
                <View style={styles.menuCopy}>
                  <Text style={styles.menuItemText}>数据目录</Text>
                  <Text style={styles.menuItemSub}>查看存储位置与空间明细</Text>
                </View>
                <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />
              </TouchableOpacity>
              <View style={styles.menuInsetDivider} />
              <TouchableOpacity style={styles.menuItem} onPress={() => { toggleSidebar(false); setHelpOpen(true); }} delayPressIn={0} activeOpacity={0.65}>
                <View style={[styles.menuIconBox, { backgroundColor: colors.fill }]}>
                  <NativeIcon name="questionmark.circle" fallback={HelpCircle} size={17} color={colors.textSecondary} />
                </View>
                <View style={styles.menuCopy}>
                  <Text style={styles.menuItemText}>使用说明</Text>
                  <Text style={styles.menuItemSub}>视图、相册直读与备份指南</Text>
                </View>
                <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />
              </TouchableOpacity>
            </View>

            <Text style={styles.version}>印记 1.9.11</Text>
          </ScrollView>
        </View>
      </Animated.View>

      <View style={[styles.mainContent, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.profileBtn}
            onPress={() => { hapticSelection(); toggleSidebar(true); }}
            delayPressIn={0}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <NativeIcon name="person.fill" fallback={User} color={colors.textOnAccent} size={18} />
          </TouchableOpacity>
          <ViewSwitcher value={pillMode} onChange={changeView} />
          <View style={{ width: 36 }} /> 
        </View>

        <Text style={styles.largeTitle}>印记</Text>

        {viewMode === 'list' && (
          <View style={styles.filterBar}>
            <View style={styles.searchContainer}>
              <NativeIcon name="magnifyingglass" fallback={Search} size={15} color={colors.textMuted} style={{ marginRight: 6 }} />
              <TextInput
                style={styles.searchInput}
                placeholder="搜索标题、关键字..."
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholderTextColor={colors.textMuted}
                clearButtonMode="while-editing"
                returnKeyType="search"
              />
              {Platform.OS !== 'ios' && searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <X size={16} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              style={[styles.filterBtn, activeFilters.length > 0 && styles.filterBtnActive]}
              onPress={() => { hapticSelection(); Keyboard.dismiss(); filterSheetRef.current?.present(); }}
              delayPressIn={0}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <NativeIcon
                name="line.3.horizontal.decrease"
                fallback={ListFilter}
                size={16}
                color={activeFilters.length > 0 ? colors.accent : colors.textSecondary}
              />
              {activeFilters.length > 0 && <View style={styles.filterDot} />}
            </TouchableOpacity>
          </View>
        )}

        {/* 一次只显示一个视图。列表 / 日历用 display:none 切换（各自独立出现）；
            地图单独一层常驻：尺寸始终有效，切走时只把透明度降到 0，
            这样 Leaflet 不会把瓦片卸掉，切回来是秒开、不用重新下载 */}
        <View
          style={styles.viewArea}
          ref={viewAreaRef}
          collapsable={false}
          onLayout={() => setTimeout(measureMapRect, 0)}
        >
        <Reanimated.View style={[styles.listWrapper, viewMode !== 'list' && styles.hiddenView, viewFadeStyle]}>
          {/* 首页列表整体淡入，避免进入页面时的生硬闪现 */}
          <Reanimated.View entering={FadeIn.duration(250)} style={{ flex: 1 }}>
            <FlatList
              data={filteredAndSortedData}
              keyExtractor={rowKeyExtractor}
              renderItem={renderItem}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.listContent, { paddingBottom: Math.max(78, insets.bottom + 68) }]}
              bounces={Platform.OS === 'ios'}
              overScrollMode="never"
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              // 行高固定 → 直接给出布局，省掉逐行测量
              getItemLayout={rowItemLayout}
              // 虚拟化：默认 windowSize=21 会把上下各 10 屏的行都挂出来（每行还有一个
              // 滑动手势 + 封面），滚动时不断挂载/卸载就是掉帧的来源。收到 7 屏，
              // 首屏 8 行、每批 8 行，Android 上再裁掉屏幕外的行
              initialNumToRender={8}
              // 每批 4 行、每 24ms 一批：一帧要挂的原生 View 少了，掉帧就从"一次卡一下"
              // 变成看不出来。4 行/帧 ≈ 240 行/秒，远快于任何甩动速度，不会露白
              maxToRenderPerBatch={4}
              windowSize={6}
              updateCellsBatchingPeriod={24}
              removeClippedSubviews={Platform.OS === 'android'}
            />
          </Reanimated.View>
        </Reanimated.View>

        {/* 月示图：日历 + 当月 / 当日时间线（行与列表同一套，右滑同样能改 / 删） */}
        <Reanimated.View style={[styles.monthWrapper, viewMode !== 'month' && styles.hiddenView, viewFadeStyle]}>
          <MonthView
            records={sortedData}
            onPressItem={openDetail}
            onEditItem={editItem}
            onDeleteItem={handleDeleteItem}
          />
        </Reanimated.View>

        </View>
      </View>

      {/* 地图层：根容器的直接子节点（首帧量好位置后才挂 WebView）。
          全屏 = 整屏铺满 + 内容转 90°；平时 = 量出来的 viewArea 位置 */}
      {mapMounted && (
        <Reanimated.View
          // 侧边栏 / 设置 / 说明 打开时，常驻在最上层的地图 WebView 一律不碰触摸：
          // 它抢触摸的话，侧边栏里那几项就会"点了没反应"
          pointerEvents={viewMode === 'map' && !isSidebarOpen && !settingsOpen && !helpOpen ? 'auto' : 'none'}
          style={[styles.mapLayer, mapLayerBox, mapFullscreen && styles.mapLayerFullscreen, mapLayerStyle]}
        >
          {/* collapsable={false}：这两层的位置/尺寸就是全屏几何本身，
              必须保证它们在原生侧真实存在，不能被 RN 的视图扁平化优化掉 */}
          <View style={[styles.mapStage, mapStageBox]} collapsable={false}>
            <View style={[styles.mapBox, mapBoxRotated]} collapsable={false}>
              <WebView
                ref={mapRef}
                originWhitelist={['*']}
                source={mapSource}
                style={styles.map}
                scrollEnabled={false}
                bounces={false}
                allowsInlineMediaPlayback
                allowsLinkPreview={false}
                contentInsetAdjustmentBehavior="never"
                onMessage={(e) => {
                  // 地图弹窗里点「查看详情」→ 跳转到对应印记的详情页
                  try {
                    const msg = JSON.parse(e.nativeEvent.data);
                    if (msg.type === 'openDetail') {
                      const item = logData.find(l => String(l.id) === String(msg.id));
                      openDetailFromMap(item);
                    } else if (msg.type === 'mapFullscreen') {
                      // 地图上的「全屏」按钮：地图铺满整屏并横过来，再点一次还原
                      if (msg.on) enterMapFullscreen();
                      else exitMapFullscreen();
                    } else if (msg.type === 'jsApiFailed') {
                      // 高德 JS API 没出图（key / 安全密钥 / 网络 / WebGL）：切回栅格底图，
                      // 地图照样能用，并在顶部说明原因
                      setJsApiFailed(true);
                    }
                  } catch {}
                }}
                />
            </View>
          </View>
        </Reanimated.View>
      )}

      {/* 同步进度条：常驻底部，同步结束就消失，不跟结果弹窗抢屏幕 */}
      {syncing && (
        <View style={[styles.syncPill, { bottom: Math.max(28, insets.bottom + 16) }]} pointerEvents="none">
          <ActivityIndicator size="small" color="#FFF" />
          <Text style={styles.syncPillText}>
            正在同步照片{syncProgress ? ` ${syncProgress.done}/${syncProgress.total}` : ''}
          </Text>
        </View>
      )}

      <BottomSheetModal
        ref={filterSheetRef}
        index={0}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: colors.bgElevated }}
        handleIndicatorStyle={{ backgroundColor: colors.sheetHandle }}
        animationConfigs={{ damping: 24, stiffness: 220, mass: 0.9 }}
        onChange={(index) => setSheetOpen(index != null && index >= 0)}
        onDismiss={() => setSheetOpen(false)}
      >
        <BottomSheetView style={styles.sheetHeader}>
          <BottomSheetTouchableOpacity onPress={() => setActiveFilters([])} style={styles.headerHitSlop}><Text style={styles.sheetBtnTextGray}>重置</Text></BottomSheetTouchableOpacity>
          <Text style={styles.sheetTitle}>筛选</Text>
          <BottomSheetTouchableOpacity onPress={() => filterSheetRef.current?.dismiss()} style={styles.headerHitSlop}><Text style={styles.sheetBtnTextBlue}>完成</Text></BottomSheetTouchableOpacity>
        </BottomSheetView>
        <BottomSheetScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
          {/* 时间筛选已去掉：按年月看记录改到「日历」页里点年月选择 */}
          <Text style={styles.categoryTitle}>记录类型</Text>
          <Text style={styles.sectionTitle}>旅票</Text>
          <View style={styles.chipGrid}>
            {subTypeOptions.ticket.map(sub => (<BottomSheetTouchableOpacity key={sub.id} onPress={() => setActiveFilters(prev => activeFilters.includes(sub.id) ? prev.filter(f => f !== sub.id) : [...prev, sub.id])} style={[styles.chip, activeFilters.includes(sub.id) && styles.chipActive]}>{activeFilters.includes(sub.id) && <Check size={15} color={colors.accent} style={styles.checkIcon}/>}<Text style={[styles.chipText, activeFilters.includes(sub.id) && styles.chipTextActive]}>{sub.label}</Text></BottomSheetTouchableOpacity>))}
          </View>
          <Text style={styles.sectionTitle}>地点</Text>
          <View style={styles.chipGrid}>
            <BottomSheetTouchableOpacity onPress={() => setActiveFilters(prev => prev.includes('location') ? prev.filter(f => f !== 'location') : [...prev, 'location'])} style={[styles.chip, activeFilters.includes('location') && styles.chipActiveRed]}>{activeFilters.includes('location') && <Check size={15} color={colors.danger} style={styles.checkIcon}/>}<Text style={[styles.chipText, activeFilters.includes('location') && styles.chipTextActiveRed]}>地点</Text></BottomSheetTouchableOpacity>
          </View>
          <Text style={styles.sectionTitle}>娱乐与阅读</Text>
          <View style={styles.chipGrid}>
            {subTypeOptions.media.map(sub => (<BottomSheetTouchableOpacity key={sub.id} onPress={() => setActiveFilters(prev => activeFilters.includes(sub.id) ? prev.filter(f => f !== sub.id) : [...prev, sub.id])} style={[styles.chip, activeFilters.includes(sub.id) && styles.chipActivePurple]}>{activeFilters.includes(sub.id) && <Check size={15} color={colors.purple} style={styles.checkIcon}/>}<Text style={[styles.chipText, activeFilters.includes(sub.id) && styles.chipTextActivePurple]}>{sub.label}</Text></BottomSheetTouchableOpacity>))}
          </View>
          <Text style={styles.sectionTitle}>随笔</Text>
          <View style={styles.chipGrid}>
            {NOTE_SUB_OPTIONS.map(sub => (<BottomSheetTouchableOpacity key={sub.id} onPress={() => setActiveFilters(prev => activeFilters.includes(sub.id) ? prev.filter(f => f !== sub.id) : [...prev, sub.id])} style={[styles.chip, activeFilters.includes(sub.id) && styles.chipActiveGreen]}>{activeFilters.includes(sub.id) && <Check size={15} color={colors.groupNote} style={styles.checkIcon}/>}<Text style={[styles.chipText, activeFilters.includes(sub.id) && styles.chipTextActiveGreen]}>{sub.label}</Text></BottomSheetTouchableOpacity>))}
          </View>
        </BottomSheetScrollView>
      </BottomSheetModal>

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <TouchableOpacity style={styles.settingsOverlay} activeOpacity={1} onPress={() => setSettingsOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.settingsCard} onPress={() => {}}>
            <Text style={styles.settingsTitle}>设置</Text>
            <Text style={styles.settingsLabel}>地图服务</Text>
            <View style={styles.providerRow}>
              {[{ id: 'tianditu', label: '天地图' }, { id: 'amap', label: '高德' }].map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.providerChip, providerDraft === p.id && styles.providerChipOn]}
                  onPress={() => switchProviderDraft(p.id)}
                >
                  <Text style={[styles.providerChipText, providerDraft === p.id && styles.providerChipTextOn]}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[styles.settingsLabel, { marginTop: 14 }]}>
              {providerDraft === 'amap' ? '高德 Web 服务 Key' : '天地图 Key'}
            </Text>
            <TextInput
              style={styles.settingsInput}
              value={keyDraft}
              onChangeText={setKeyDraft}
              placeholder={providerDraft === 'amap' ? '高德 Web 服务 Key' : '天地图 tk'}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {providerDraft === 'amap' && (
              <>
                <Text style={[styles.settingsLabel, { marginTop: 14 }]}>高德 Web 端(JS API) Key</Text>
                <TextInput
                  style={styles.settingsInput}
                  value={jsKeyDraft}
                  onChangeText={setJsKeyDraft}
                  placeholder="选填"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={[styles.settingsLabel, { marginTop: 10 }]}>安全密钥 securityJsCode</Text>
                <TextInput
                  style={styles.settingsInput}
                  value={jsCodeDraft}
                  onChangeText={setJsCodeDraft}
                  placeholder="选填"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </>
            )}
            <View style={styles.settingsBtnRow}>
              <TouchableOpacity style={[styles.settingsBtn, styles.settingsBtnCancel]} onPress={() => setSettingsOpen(false)}>
                <Text style={styles.settingsBtnCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.settingsBtn, styles.settingsBtnSave]} onPress={saveKey}>
                <Text style={styles.settingsBtnSaveText}>保存</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal transparent visible={nameEditorOpen} animationType="fade" onRequestClose={() => setNameEditorOpen(false)}>
        <TouchableOpacity style={styles.nameOverlay} activeOpacity={1} onPress={() => setNameEditorOpen(false)}>
          <TouchableOpacity style={styles.nameCard} activeOpacity={1} onPress={() => {}}>
            <Text style={styles.nameTitle}>修改名字</Text>
            <TextInput
              style={styles.nameInput}
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="输入名字"
              placeholderTextColor={colors.textMuted}
              maxLength={20}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={saveProfileName}
            />
            <View style={styles.nameBtnRow}>
              <TouchableOpacity style={[styles.nameBtn, styles.nameBtnCancel]} onPress={() => setNameEditorOpen(false)}>
                <Text style={styles.nameBtnCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.nameBtn, styles.nameBtnSave]} onPress={saveProfileName}>
                <Text style={styles.nameBtnSaveText}>保存</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <HelpModal visible={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* 清理缓存：二级选项，挑清哪些（都是可再生内容，不影响记录和照片引用） */}
      <Modal transparent visible={cachePickerOpen} animationType="fade" onRequestClose={() => setCachePickerOpen(false)}>
        <TouchableOpacity style={styles.settingsOverlay} activeOpacity={1} onPress={() => setCachePickerOpen(false)}>
          <TouchableOpacity style={styles.settingsCard} activeOpacity={1} onPress={() => {}}>
            <Text style={styles.settingsTitle}>清理缓存</Text>
            <Text style={styles.settingsLabel}>勾选要清理的项（都是可再生内容）</Text>
            {CACHE_TARGETS.map(({ key, label, note }) => (
              <TouchableOpacity
                key={key}
                style={styles.cacheRow}
                activeOpacity={0.75}
                onPress={() => {
                  hapticSelection();
                  setCacheTargets((prev) => ({ ...prev, [key]: !prev[key] }));
                }}
              >
                {Platform.OS !== 'ios' && (
                  <View style={[styles.cacheBox, cacheTargets[key] && styles.cacheBoxOn]}>
                    {cacheTargets[key] && <Check size={14} color={colors.textOnAccent} />}
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.cacheRowLabel}>{label}</Text>
                  {!!note && <Text style={styles.cacheRowNote}>{note}</Text>}
                </View>
                {Platform.OS === 'ios' && (
                  <Switch
                    value={!!cacheTargets[key]}
                    onValueChange={(val) => setCacheTargets((prev) => ({ ...prev, [key]: val }))}
                    trackColor={{ false: colors.fillStrong, true: colors.accent }}
                  />
                )}
              </TouchableOpacity>
            ))}
            <View style={styles.settingsBtnRow}>
              <TouchableOpacity style={[styles.settingsBtn, styles.settingsBtnCancel]} onPress={() => setCachePickerOpen(false)}>
                <Text style={styles.settingsBtnCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.settingsBtn, styles.settingsBtnSave]} onPress={runCleanCache}>
                <Text style={styles.settingsBtnSaveText}>开始清理</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// 样式表随色板生成：浅色 / 深色各建一次，切换主题时整体换掉
const makeStyles = (c) => ({
  container: { flex: 1, backgroundColor: c.bg },
  mainContent: { flex: 1 },
  // 全屏时让页面主体压过侧边栏（地图铺满整屏后，侧边栏/遮罩还在同一层里）
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, height: 44 },
  profileBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.accent, justifyContent: 'center', alignItems: 'center' },
  largeTitle: { fontSize: 34, fontWeight: 'bold', paddingHorizontal: 16, marginTop: 10, marginBottom: 10, color: c.textStrong },
  segmentedControl: { flexDirection: 'row', backgroundColor: c.fill, borderRadius: 9, padding: 2, width: 204 },
  nativeSegmented: { width: 210, height: 32 },
  // 药丸不要挂 elevation/阴影：Android 上移动的阴影每帧都要重画，高亮滑动会一顿一顿的
  segmentPill: { position: 'absolute', left: 2, top: 2, bottom: 2, borderRadius: 7, backgroundColor: c.bgElevated,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  segmentBtn: { flex: 1, paddingVertical: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 7, zIndex: 1 },
  segmentText: { fontSize: 13, color: c.textSecondary, fontWeight: '500' },
  segmentTextActive: { color: c.textStrong, fontWeight: '600' },
  filterBar: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 8, alignItems: 'center' },
  searchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: c.fill, borderRadius: 10, paddingHorizontal: 10, height: 36, marginRight: 10 },
  searchInput: { flex: 1, fontSize: 14, color: c.text, paddingVertical: 0 },
  filterBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.fill, justifyContent: 'center', alignItems: 'center' },
  filterBtnActive: { backgroundColor: c.accentSoft },
  filterDot: { position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: 3, backgroundColor: c.danger },
  listWrapper: { flex: 1, backgroundColor: c.bgElevated, marginHorizontal: 16, marginTop: 4, marginBottom: 0, borderRadius: 14, overflow: 'hidden' },
  listContent: { paddingBottom: 78 },
  monthWrapper: { flex: 1, marginTop: 2, marginBottom: 0 },
  hiddenView: { display: 'none' },
  viewArea: { flex: 1 },
  // 全屏时把承载地图的容器抬到最上层：地图层靠负的四周补偿撑满整屏，
  // 会盖住头部和标题，所以容器本身也要压过侧边栏（侧边栏 zIndex 100）
  // 地图层：绝对定位，位置/尺寸由测量给出（全屏时就是整屏）；隐藏时只降透明度，
  // 尺寸不变 → Leaflet 不会卸载瓦片
  mapLayer: { position: 'absolute', borderRadius: 14, overflow: 'hidden' },
  // 全屏：铺满整屏、圆角归零、抬到最上层；overflow 必须放开，
  // 否则"横过来"的那层（布局框比屏幕大）会被裁成一条带
  mapLayerFullscreen: { borderRadius: 0, overflow: 'visible', zIndex: 300 },
  // 舞台：平时就是普通的一层（铺满地图层），全屏时换成居中的正方形（尺寸在 JS 里算）
  mapStage: { flex: 1 },
  mapBox: { flex: 1 },
  emptyText: { fontSize: 14, color: c.textMuted },
  map: { flex: 1 },
  exportBtn: { position: 'absolute', right: 20, backgroundColor: c.text, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 25 },
  exportBtnText: { color: c.bgElevated, marginLeft: 8, fontWeight: '600' },
  sidebarOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: c.scrim, zIndex: 99 },
  sidebar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: SIDEBAR_WIDTH, backgroundColor: c.bg, zIndex: 100 },
  sidebarContent: { flex: 1 },
  profileTopbar: { height: 48, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  profileTopTitle: { fontSize: 17, fontWeight: '600', color: c.textStrong },
  profileBackWrap: {
    width: 38, height: 38, borderRadius: 19, overflow: 'hidden',
    shadowColor: c.shadow, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 6, elevation: 2,
  },
  profileBack: {
    width: 38, height: 38, alignItems: 'center', justifyContent: 'center',
  },
  profileScrollContent: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 32 },
  profileCard: { backgroundColor: c.bgElevated, borderRadius: 20, padding: 18, paddingBottom: 16 },
  profileIdentity: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  profileAvatar: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  profileAvatarImage: { width: 64, height: 64, borderRadius: 32 },
  avatarEditBadge: {
    position: 'absolute', right: -1, bottom: -1, width: 22, height: 22, borderRadius: 11,
    backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: c.bgElevated,
  },
  profileCopy: { flex: 1, gap: 4 },
  profileNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  profileName: { fontSize: 21, fontWeight: '700', color: c.textStrong, letterSpacing: -0.3 },
  profileSub: { fontSize: 12.5, color: c.textMuted },
  profileStats: {
    flexDirection: 'row', marginTop: 16, paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider,
  },
  profileStat: {
    flex: 1, alignItems: 'center', gap: 3,
    borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: c.divider,
  },
  profileStatLast: { borderRightWidth: 0 },
  profileStatNum: { fontSize: 20, lineHeight: 24, fontWeight: '700', color: c.textStrong, fontVariant: ['tabular-nums'] },
  profileStatLabel: { fontSize: 12, color: c.textMuted },
  groupLabel: { marginTop: 22, marginBottom: 8, paddingHorizontal: 12, fontSize: 13, fontWeight: '500', color: c.textMuted },
  menuCard: { backgroundColor: c.bgElevated, borderRadius: 16, overflow: 'hidden' },
  syncPill: {
    position: 'absolute', left: 40, right: 40, bottom: 28,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.75)',
  },
  syncPillText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  menuItem: {
    minHeight: 58, paddingHorizontal: 16, paddingVertical: 11, flexDirection: 'row', alignItems: 'center',
  },
  menuInsetDivider: {
    height: StyleSheet.hairlineWidth, backgroundColor: c.divider, marginLeft: 60,
  },
  menuIconBox: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  menuCopy: { flex: 1, gap: 2 },
  menuItemText: { fontSize: 15.5, fontWeight: '500', color: c.text },
  menuItemSub: { fontSize: 12.5, color: c.textMuted, marginTop: 1 },
  appearanceCard: { backgroundColor: c.bgElevated, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  appearanceNativeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  appearanceNativeLabel: { fontSize: 15.5, fontWeight: '500', color: c.text },
  appearanceNativeSeg: { width: 174, height: 32 },
  appearanceOptions: { flexDirection: 'row', gap: 8 },
  appearanceOption: {
    flex: 1, height: 38, borderRadius: 10, borderWidth: 1, borderColor: c.border,
    backgroundColor: c.bgSunken, alignItems: 'center', justifyContent: 'center',
  },
  appearanceOptionOn: { borderColor: c.accent, backgroundColor: c.accentSoft },
  appearanceOptionText: { fontSize: 13.5, color: c.textSecondary, fontWeight: '500' },
  appearanceOptionTextOn: { color: c.accent, fontWeight: '600' },
  nameOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', alignItems: 'center', padding: 32 },
  nameCard: { width: '100%', backgroundColor: c.bgElevated, borderRadius: 16, padding: 18 },
  nameTitle: { fontSize: 17, fontWeight: '600', color: c.text, marginBottom: 14 },
  nameInput: {
    height: 44, borderWidth: 1, borderColor: c.border, borderRadius: 10,
    backgroundColor: c.bgSunken, paddingHorizontal: 12, fontSize: 15, color: c.text,
  },
  nameBtnRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  nameBtn: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 8, marginLeft: 10 },
  nameBtnCancel: { backgroundColor: c.bgSunken },
  nameBtnCancelText: { fontSize: 14, color: c.textSecondary },
  nameBtnSave: { backgroundColor: c.accent },
  nameBtnSaveText: { fontSize: 14, fontWeight: '600', color: c.textOnAccent },
  version: { textAlign: 'center', color: c.textMuted, fontSize: 12, marginTop: 24, marginBottom: 4 },
  themeRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, marginBottom: 2, gap: 6 },
  themeChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, backgroundColor: c.bgSunken, borderWidth: 1, borderColor: c.border },
  themeChipActive: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  themeChipText: { fontSize: 11, color: c.textSecondary },
  themeChipTextActive: { color: c.accent, fontWeight: '600' },
  settingsOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', alignItems: 'center', padding: 32 },
  settingsCard: { width: '100%', backgroundColor: c.bgElevated, borderRadius: 14, padding: 18 },
  settingsTitle: { fontSize: 17, fontWeight: '600', color: c.text, marginBottom: 14 },
  settingsLabel: { fontSize: 13, fontWeight: '500', color: c.textMuted, marginBottom: 8 },
  providerRow: { flexDirection: 'row', gap: 8 },
  providerChip: { flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: c.bgSunken,
    borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  providerChipOn: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  providerChipText: { fontSize: 14, color: c.textSecondary },
  providerChipTextOn: { color: c.accent, fontWeight: '600' },
  settingsInput: { borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.bgSunken, paddingHorizontal: 12, height: 44, fontSize: 14, color: c.text },
  settingsBtnRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  settingsBtn: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 8, marginLeft: 10 },
  settingsBtnCancel: { backgroundColor: c.bgSunken },
  settingsBtnCancelText: { fontSize: 14, color: c.textSecondary },
  settingsBtnSave: { backgroundColor: c.accent },
  settingsBtnSaveText: { fontSize: 14, fontWeight: '600', color: c.textOnAccent },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSoft, backgroundColor: c.bgElevated, zIndex: 10 },
  headerHitSlop: { padding: 10, margin: -10 },
  sheetTitle: { fontSize: 17, fontWeight: '600', color: c.text },
  sheetBtnTextGray: { fontSize: 16, color: c.textSecondary },
  sheetBtnTextBlue: { fontSize: 16, fontWeight: '600', color: c.accent },
  sheetScroll: { flex: 1, paddingHorizontal: 20, paddingTop: 10 },
  categoryTitle: { fontSize: 18, fontWeight: 'bold', color: c.text, marginTop: 12, marginBottom: 4 },
  sectionTitle: { fontSize: 13, fontWeight: '500', color: c.textMuted, marginBottom: 12, marginTop: 8 },
  horizontalScroll: { flexDirection: 'row', marginBottom: 20 },
  monthSection: { marginBottom: 20 },
  divider: { height: 1, backgroundColor: c.border, marginVertical: 16 },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20 },
  chip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 36, backgroundColor: c.bgSunken, paddingHorizontal: 16, borderRadius: 18, borderWidth: 1, borderColor: c.borderSoft, marginRight: 10, marginBottom: 10 },
  chipText: { fontSize: 14, color: c.textSecondary },
  checkIcon: { marginRight: 4, marginTop: 1 }, 
  chipActive: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  chipTextActive: { color: c.accent, fontWeight: '500' },
  chipActiveRed: { backgroundColor: c.dangerSoft, borderColor: c.dangerSoftBorder },
  chipTextActiveRed: { color: c.danger, fontWeight: '500' },
  chipActivePurple: { backgroundColor: c.purpleSoft, borderColor: c.purpleSoftBorder },
  chipTextActivePurple: { color: c.purple, fontWeight: '500' },
  chipActiveGreen: { backgroundColor: c.groupNoteSoft, borderColor: c.groupNoteSoft },
  chipTextActiveGreen: { color: c.groupNote, fontWeight: '500' },
  // 清理缓存的二级选项（多选行）
  cacheRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 9, gap: 10 },
  cacheBox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: c.border,
    alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  cacheBoxOn: { backgroundColor: c.accent, borderColor: c.accent },
  cacheRowLabel: { fontSize: 14, color: c.text },
  cacheRowNote: { fontSize: 11.5, color: c.textMuted, marginTop: 2, lineHeight: 16 },
});
