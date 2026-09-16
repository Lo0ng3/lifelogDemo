import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Dimensions, Animated, TextInput, Alert, BackHandler, ToastAndroid, Platform, Modal
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  User, ListFilter, Check, Search, X, RefreshCw, Upload, Download, Eraser, Settings
} from 'lucide-react-native';
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
import { exportBackup, importBackup } from '../utils/backup';
import { cleanupMediaCaches } from '../utils/media';
import { shortPlaceName } from '../utils/format';
import { buildMapHtml } from '../utils/mapHtml';
import { LEAFLET_JS, LEAFLET_CSS } from '../vendor/leafletBundle';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { NOTE_SUB_OPTIONS, TICKET_SUB_OPTIONS, MEDIA_SUB_OPTIONS } from '../utils/recordMeta';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const subTypeOptions = { ticket: TICKET_SUB_OPTIONS, media: MEDIA_SUB_OPTIONS };

const VIEWS = [
  { id: 'list', label: '列表' },
  { id: 'month', label: '日历' },
  { id: 'map', label: '地图' },
];

// 视图切换：白色药丸跟着选中项滑动（原来是一格一格硬切，现在带弹簧过渡）
function ViewSwitcher({ value, onChange }) {
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
  const { logData, syncMedia, importLogs, tdtKey, setTdtKey } = useContext(LogContext);
  // 外观：始终跟随系统（和开屏图保持一致）
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const [syncing, setSyncing] = useState(false);

  // 地图服务 Key 设置弹窗
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const openSettings = () => { setKeyDraft(tdtKey); setSettingsOpen(true); };
  const saveKey = async () => {
    await setTdtKey(keyDraft);
    setSettingsOpen(false);
    if (Platform.OS === 'android') ToastAndroid.show(keyDraft.trim() ? '天地图 Key 已保存' : '已清除天地图 Key', ToastAndroid.SHORT);
  };

  // 相册同步：把断链的影像重新关联到相册原片（升级/换机/重装后的修复入口）
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    toggleSidebar(false);
    if (Platform.OS === 'android') ToastAndroid.show('正在扫描相册，同步影像…', ToastAndroid.SHORT);
    try {
      const report = await syncMedia((done, total) => {
        // 记录多时整个过程可能要跑一阵子，定期刷一下进度避免看起来像卡死
        if (Platform.OS === 'android' && total > 20 && done % 20 === 0 && done < total) {
          ToastAndroid.show(`正在扫描相册，同步影像… ${done}/${total}`, ToastAndroid.SHORT);
        }
      });
      if (report.permissionDenied) {
        const state = report.permState || {};
        Alert.alert(
          '无法同步',
          `需要相册访问权限才能把记录和相册里的原片重新关联，请在系统设置中授权。\n（当前权限状态：granted=${state.granted}, accessPrivileges=${state.accessPrivileges}）`
        );
        return;
      }
      const broken = report.unmatched;
      let message;
      if (report.matched > 0) {
        message = `已重新关联 ${report.matched} 个影像。`;
        if (report.freedCopies > 0) {
          message += `\n已清理 ${report.freedCopies} 个本地副本，改用相册原片（为应用释放了存储空间）。`;
        }
        if (broken.length > 0) {
          message += `\n\n仍有 ${broken.length} 条记录无法自动恢复（原片可能已不在相册）：\n${broken.slice(0, 5).map(r => `· ${r.title}`).join('\n')}${broken.length > 5 ? '\n…' : ''}`;
        }
      } else if (broken.length > 0) {
        message = `没有可自动恢复的影像。${broken.length} 条记录的媒体在相册中找不到对应文件，可能需要重新添加：\n${broken.slice(0, 5).map(r => `· ${r.title}`).join('\n')}${broken.length > 5 ? '\n…' : ''}`;
      } else {
        message = '所有影像都能正常显示，无需修复。';
      }
      Alert.alert('同步完成', message);
    } catch (e) {
      console.error('同步相册失败', e);
      Alert.alert('同步失败', `扫描相册时出现问题：${e?.message || e}`);
    } finally {
      setSyncing(false);
    }
  };

  // 备份导出：把全部记录写成 JSON 文件到用户选的文件夹
  const handleExportBackup = async () => {
    toggleSidebar(false);
    const result = await exportBackup(logData);
    if (result.canceled) return;
    if (result.ok) {
      Alert.alert(
        '导出成功',
        `已备份 ${result.count} 条记录${result.covers ? `、${result.covers} 张封面文件` : ''}：\n${result.name}\n\n备份文件可在换机后通过"导入备份"恢复。`
      );
    } else {
      Alert.alert('导出失败', result.error || '写入备份文件时出现问题，请稍后再试。');
    }
  };

  // 备份导入：文件选择器直接选一份备份 JSON → 确认覆盖/合并 → 导入后引导同步相册重新关联影像
  const doImport = async (logs, mode, coversRestored) => {
    const report = await importLogs(logs, mode);
    Alert.alert(
      '导入完成',
      (mode === 'replace'
        ? `已覆盖恢复，当前共 ${report.total} 条记录。`
        : `已合并导入：新增 ${report.added} 条、更新 ${report.updated} 条，当前共 ${report.total} 条。`)
        + (coversRestored ? `\n已恢复 ${coversRestored} 张封面文件。` : ''),
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
    Alert.alert(
      '导入备份',
      `备份文件：${result.name}\n包含 ${result.count} 条记录${exportedAt}\n当前有 ${logData.length} 条记录。\n\n选择导入方式：`,
      [
        { text: '取消', style: 'cancel' },
        { text: '覆盖现有', style: 'destructive', onPress: () => doImport(result.logs, 'replace', result.coversRestored) },
        { text: '合并去重', onPress: () => doImport(result.logs, 'merge', result.coversRestored) },
      ]
    );
  };
  
  // 清理缓存：封面帧/实况提取/浏览缓存都是可再生内容，清掉立刻释放空间
  const handleCleanCache = async () => {
    toggleSidebar(false);
    try {
      const freed = await cleanupMediaCaches();
      const mb = Math.round((freed / 1024 / 1024) * 10) / 10;
      Alert.alert('清理完成', `已释放 ${mb} MB 缓存空间。封面帧等会在使用中自动重建。`);
    } catch (e) {
      Alert.alert('清理失败', e?.message || '清理缓存时出现问题，请稍后再试。');
    }
  };

  const [viewMode, setViewMode] = useState('list'); 
  const [pillMode, setPillMode] = useState('list');   // 药丸的选中态，跟手一点
  const pendingView = useRef(null);                   // 最近一次点击的目标视图
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const sidebarAnim = useRef(new Animated.Value(-SCREEN_WIDTH * 0.5)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;

  const toggleSidebar = (open) => {
    setIsSidebarOpen(open);
    Animated.spring(sidebarAnim,
      {
        toValue: open ? 0 : -SCREEN_WIDTH * 0.5,
        useNativeDriver: true,
        stiffness: 150,  // ✨ 增加刚度，让弹出更迅速
        damping: 20,     // ✨ 增加阻尼，消除回弹的抖动
        mass: 0.8        // ✨ 减轻质量，让动画看起来更轻盈
      }
    ).start();
    Animated.timing(overlayAnim, { toValue: open ? 1 : 0, duration: 200, useNativeDriver: true }).start();
  };

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
  }, [navigation, sheetOpen]);

  const renderBackdrop = useCallback(
    (props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />, []
  );

  const filteredAndSortedData = useMemo(() => {
    let result = [...logData];
    if (searchQuery.trim().length > 0) {
      const lowerQuery = searchQuery.toLowerCase();
      result = result.filter(item => (item.title && item.title.toLowerCase().includes(lowerQuery)) || (item.subtitle && item.subtitle.toLowerCase().includes(lowerQuery)) || (item.comment && item.comment.toLowerCase().includes(lowerQuery)));
    }
    if (activeFilters.length > 0) {
      result = result.filter(item => activeFilters.includes(item.subType) || activeFilters.includes(item.baseType));
    }
    result.sort((a, b) => new Date(b.date) - new Date(a.date));
    return result;
  }, [logData, activeFilters, searchQuery]);

  // 地图数据：打点（地点坐标 / 旅票起终点）+ 轨迹段（出发地→目的地聚合）
  const mapData = useMemo(() => {
    // 坐标统一成有限数字：字符串/缺失/异常值一律当没有坐标处理。
    // （坐标脏数据会让 Leaflet 直接抛 "Invalid LatLng object"，把后面的绘制和控件全带崩）
    const coord = (v) => {
      if (v == null || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const latLngOf = (p, latKey = 'latitude', lngKey = 'longitude') => {
      const lat = coord(p?.[latKey]), lng = coord(p?.[lngKey]);
      return lat == null || lng == null ? null : { lat, lng };
    };
    // 打点：地点用 coordinates；旅票用 start/end（坐标缺失的记录跳过）
    const points = [];
    filteredAndSortedData.forEach(item => {
      const note = item.comment || item.subtitle || '';
      const location = latLngOf(item.coordinates);
      if (location) {
        points.push({ id: item.id, kind: 'location', title: item.title, date: item.date, note, lat: location.lat, lng: location.lng });
      }
      [item.start, item.end].forEach(p => {
        const at = latLngOf(p);
        if (at) {
          points.push({ id: item.id, kind: 'ticket', subType: item.subType, title: shortPlaceName(p.name || item.title), date: item.date, note, lat: at.lat, lng: at.lng });
        }
      });
    });
    // 轨迹段：按 出发地→目的地 聚合（单向），往返分居弧线两侧，粗细 = 次数。
    // 分段键用坐标而不是名称：同一段被改成不同别名后仍算同一条线
    const segMap = new Map();
    filteredAndSortedData
      .filter(item => item.baseType === 'ticket' && latLngOf(item.start) && latLngOf(item.end))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .forEach(t => {
        const from = { name: t.start?.name || '', longitude: coord(t.start.longitude), latitude: coord(t.start.latitude) };
        const to = { name: t.end?.name || '', longitude: coord(t.end.longitude), latitude: coord(t.end.latitude) };
        const key = [from, to].map(p => p.longitude.toFixed(4) + ',' + p.latitude.toFixed(4)).join('→');
        if (!segMap.has(key)) segMap.set(key, { from, to, count: 0, subType: t.subType });
        const seg = segMap.get(key);
        seg.count++;
        seg.from = from; seg.to = to;   // 显示名称取最近一次的别名
      });
    const segs = [...segMap.values()];
    return { points, segs };
  }, [filteredAndSortedData]);

  // 地图 HTML：Leaflet 本地内联注入 + 主题配色，深浅色切换时只重建这一份字符串
  const mapHtml = useMemo(() => buildMapHtml({
    points: mapData.points,
    segs: mapData.segs,
    tdtKey,
    colors: colors.map,
    leafletJs: LEAFLET_JS,
    leafletCss: LEAFLET_CSS,
  }), [mapData, tdtKey, colors.map]);


  const openDetail = useCallback((item) => navigation.navigate('Detail', { item }), [navigation]);
  const editItem = useCallback((item) => navigation.navigate('Edit', { editItem: item }), [navigation]);

  const renderItem = useCallback(({ item, index }) => (
    <RecordRow
      item={item}
      isLast={index === filteredAndSortedData.length - 1}
      onPress={openDetail}
      onEdit={editItem}
    />
  ), [filteredAndSortedData.length, openDetail, editItem]);

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
    if (id === 'map') setTimeout(() => { if (pendingView.current === id) setViewMode(id); }, 130);
    else setViewMode(id);
  }, []);

  return (
    <View style={styles.container}>

      {isSidebarOpen && (
        <Animated.View style={[styles.sidebarOverlay, { opacity: overlayAnim }]}>
          <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={() => toggleSidebar(false)} />
        </Animated.View>
      )}
      <Animated.View style={[styles.sidebar, { transform: [{ translateX: sidebarAnim }] }]}>
        <View style={[styles.sidebarContent, { paddingTop: insets.top + 20 }]}>
          <View style={styles.sidebarHeader}><View style={styles.largeAvatar}><User color={colors.textOnAccent} size={40} /></View><Text style={styles.userName}>我</Text></View>
          <View style={styles.statsRow}>
            <View style={styles.statItem}><Text style={styles.statNum}>{logData.length}</Text><Text style={styles.statLabel}>总印记</Text></View>
          </View>
          <View style={styles.sidebarMenu}>
            <TouchableOpacity style={styles.menuItem} onPress={openSettings}>
              <Settings size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.menuItemText}>地图服务 Key</Text>
                <Text style={styles.menuItemSub}>{tdtKey ? '天地图服务已配置' : '未配置，地图与联想不可用'}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleSync} disabled={syncing}>
              <RefreshCw size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
              <Text style={styles.menuItemText}>{syncing ? '正在同步…' : '同步相册影像'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleExportBackup}>
              <Upload size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
              <Text style={styles.menuItemText}>导出备份</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleImportBackup}>
              <Download size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
              <Text style={styles.menuItemText}>导入备份</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleCleanCache}>
              <Eraser size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
              <Text style={styles.menuItemText}>清理缓存</Text>
            </TouchableOpacity>
            {/* 外观：默认跟随系统（白天浅色 / 夜间深色），也可以手动固定 */}
          </View>
        </View>
      </Animated.View>

      <View style={[styles.mainContent, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.profileBtn} onPress={() => toggleSidebar(true)}><User color={colors.textOnAccent} size={20} /></TouchableOpacity>
          <ViewSwitcher value={pillMode} onChange={changeView} />
          <View style={{ width: 36 }} /> 
        </View>

        <Text style={styles.largeTitle}>印记</Text>

        {viewMode === 'list' && (
          <View style={styles.filterBar}>
            <View style={styles.searchContainer}>
              <Search size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
              <TextInput style={styles.searchInput} placeholder="搜索标题、关键字..." value={searchQuery} onChangeText={setSearchQuery} placeholderTextColor={colors.textMuted} />
              {searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery('')}><X size={16} color={colors.textMuted} /></TouchableOpacity>}
            </View>
            <TouchableOpacity style={[styles.filterBtn, activeFilters.length > 0 && styles.filterBtnActive]} onPress={() => filterSheetRef.current?.present()}>
              <ListFilter size={16} color={activeFilters.length > 0 ? colors.accent : colors.textSecondary} />
              {activeFilters.length > 0 && <View style={styles.filterDot} />}
            </TouchableOpacity>
          </View>
        )}

        {/* 一次只显示一个视图（display:none 切换）；地图出场要重新布局，
            所以由 changeView 让药丸先动、视图晚一拍再出现 */}
        <Reanimated.View style={[styles.listWrapper, viewMode !== 'list' && styles.hiddenView, viewFadeStyle]}>
          {/* 首页列表整体淡入，避免进入页面时的生硬闪现 */}
          <Reanimated.View entering={FadeIn.duration(250)} style={{ flex: 1 }}>
            <FlatList
              data={filteredAndSortedData}
              keyExtractor={(item) => item.id.toString()}
              renderItem={renderItem}
              showsVerticalScrollIndicator={false}
            />
          </Reanimated.View>
        </Reanimated.View>

        {/* 月示图：日历 + 当月 / 当日时间线（行与列表同一套，右滑同样能改 / 删） */}
        <Reanimated.View style={[styles.monthWrapper, viewMode !== 'month' && styles.hiddenView, viewFadeStyle]}>
          <MonthView
            records={filteredAndSortedData}
            onPressItem={openDetail}
            onEditItem={editItem}
          />
        </Reanimated.View>

        <Reanimated.View style={[styles.mapWrapper, viewMode !== 'map' && styles.hiddenView, viewFadeStyle]}>
          <WebView
            ref={mapRef}
            originWhitelist={['*']}
            source={{ html: mapHtml }}
            style={styles.map}
            scrollEnabled={false}
            onMessage={(e) => {
              // 地图弹窗里点「查看详情」→ 跳转到对应印记的详情页
              try {
                const msg = JSON.parse(e.nativeEvent.data);
                if (msg.type === 'openDetail') {
                  const item = logData.find(l => String(l.id) === String(msg.id));
                  if (item) navigation.navigate('Detail', { item });
                }
              } catch {}
            }}
          />
        </Reanimated.View>
      </View>

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
            <Text style={styles.settingsLabel}>天地图 Key</Text>
            <TextInput
              style={styles.settingsInput}
              value={keyDraft}
              onChangeText={setKeyDraft}
              placeholder="在 lbs.tianditu.gov.cn 免费申请"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.settingsHint}>用于地图底图、地点与出发/到达的地名联想。Key 只保存在本机，换机后需重新填写。</Text>
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
    </View>
  );
}

// 样式表随色板生成：浅色 / 深色各建一次，切换主题时整体换掉
const makeStyles = (c) => ({
  container: { flex: 1, backgroundColor: c.bg },
  mainContent: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, height: 44 },
  profileBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.accent, justifyContent: 'center', alignItems: 'center' },
  largeTitle: { fontSize: 34, fontWeight: 'bold', paddingHorizontal: 16, marginTop: 10, marginBottom: 10, color: c.textStrong },
  segmentedControl: { flexDirection: 'row', backgroundColor: c.fill, borderRadius: 9, padding: 2, width: 204 },
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
  listWrapper: { flex: 1, backgroundColor: c.bgElevated, marginHorizontal: 16, marginTop: 4, marginBottom: 20, borderRadius: 14, overflow: 'hidden' },
  monthWrapper: { flex: 1, marginTop: 2, marginBottom: 20 },
  hiddenView: { display: 'none' },
  emptyText: { fontSize: 14, color: c.textMuted },
  mapWrapper: { flex: 1, marginTop: 4, marginHorizontal: 16, marginBottom: 20, borderRadius: 14, overflow: 'hidden' },
  map: { flex: 1 },
  exportBtn: { position: 'absolute', right: 20, backgroundColor: c.text, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 25 },
  exportBtnText: { color: c.bgElevated, marginLeft: 8, fontWeight: '600' },
  sidebarOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: c.scrim, zIndex: 99 },
  sidebar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: SCREEN_WIDTH * 0.5, backgroundColor: c.bgElevated, zIndex: 100 },
  sidebarContent: { flex: 1, paddingHorizontal: 20 },
  sidebarHeader: { alignItems: 'center', marginBottom: 30 },
  largeAvatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: c.accent, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  userName: { fontSize: 18, fontWeight: 'bold', color: c.text },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 30 },
  statItem: { alignItems: 'center' },
  statNum: { fontSize: 20, fontWeight: 'bold', color: c.text },
  statLabel: { fontSize: 12, color: c.textMuted, marginTop: 4 },
  sidebarMenu: { borderTopWidth: 1, borderTopColor: c.divider, paddingTop: 10 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: c.divider },
  menuItemText: { fontSize: 16, color: c.text },
  menuItemSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  themeRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, marginBottom: 2, gap: 6 },
  themeChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, backgroundColor: c.bgSunken, borderWidth: 1, borderColor: c.border },
  themeChipActive: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  themeChipText: { fontSize: 11, color: c.textSecondary },
  themeChipTextActive: { color: c.accent, fontWeight: '600' },
  settingsOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', alignItems: 'center', padding: 32 },
  settingsCard: { width: '100%', backgroundColor: c.bgElevated, borderRadius: 14, padding: 18 },
  settingsTitle: { fontSize: 17, fontWeight: '600', color: c.text, marginBottom: 14 },
  settingsLabel: { fontSize: 13, fontWeight: '500', color: c.textMuted, marginBottom: 8 },
  settingsInput: { borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.bgSunken, paddingHorizontal: 12, height: 44, fontSize: 14, color: c.text },
  settingsHint: { fontSize: 12, color: c.textMuted, lineHeight: 18, marginTop: 8 },
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
});
