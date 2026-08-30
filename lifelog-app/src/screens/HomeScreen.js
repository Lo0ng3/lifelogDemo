import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  Dimensions, Animated, TextInput, Alert, BackHandler, ToastAndroid, Platform
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  User, Star, StarHalf, ListFilter, Check, Share2, Search, X, Edit3, Trash2, RefreshCw, Upload, Download, Eraser
} from 'lucide-react-native';
import { WebView } from 'react-native-webview';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Reanimated, { useAnimatedStyle, FadeIn } from 'react-native-reanimated';

import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  // 该库导出的手势版触摸组件名为 TouchableOpacity（无 BottomSheet 前缀），别名以免与 RN 的重名
  TouchableOpacity as BottomSheetTouchableOpacity
} from '@gorhom/bottom-sheet';

import { LogContext } from '../context/LogContext';
import CoverIcon from '../components/CoverIcon';
import PressableScale from '../components/PressableScale';
import { exportBackup, importBackup } from '../utils/backup';
import { cleanupMediaCaches } from '../utils/media';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const subTypeOptions = {
  ticket: [{ id: 'flight', label: '机票' }, { id: 'train', label: '火车票' }, { id: 'bus', label: '汽车票' }, { id: 'ship', label: '轮船' }],
  media: [{ id: 'movie', label: '电影' }, { id: 'tv', label: '剧集' }, { id: 'anime', label: '动漫' }, { id: 'game', label: '游戏' }, { id: 'book', label: '书籍' }]
};

// 右滑操作区：固定宽度保证滑动距离可测，整体随拖拽从右侧滑入（静止时完全在行外不可见）
const SWIPE_ACTIONS_WIDTH = 144;

function SwipeRightActions({ drag, onEdit, onDelete }) {
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drag.value + SWIPE_ACTIONS_WIDTH }],
  }));
  return (
    <Reanimated.View style={[styles.swipeActions, slideStyle]}>
      <TouchableOpacity style={[styles.swipeBtn, styles.swipeEditBtn]} onPress={onEdit}>
        <Edit3 size={17} color="#FFF" />
        <Text style={styles.swipeBtnText}>修改</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.swipeBtn, styles.swipeDeleteBtn]} onPress={onDelete}>
        <Trash2 size={17} color="#FFF" />
        <Text style={styles.swipeBtnText}>删除</Text>
      </TouchableOpacity>
    </Reanimated.View>
  );
}

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { logData, deleteLog, syncMedia, importLogs } = useContext(LogContext);

  const [syncing, setSyncing] = useState(false);

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
      Alert.alert('导出成功', `已备份 ${result.count} 条记录：\n${result.name}\n\n备份文件可在换机后通过"导入备份"恢复。`);
    } else {
      Alert.alert('导出失败', result.error || '写入备份文件时出现问题，请稍后再试。');
    }
  };

  // 备份导入：文件选择器直接选一份备份 JSON → 确认覆盖/合并 → 导入后引导同步相册重新关联影像
  const doImport = async (logs, mode) => {
    const report = await importLogs(logs, mode);
    Alert.alert(
      '导入完成',
      mode === 'replace'
        ? `已覆盖恢复，当前共 ${report.total} 条记录。`
        : `已合并导入：新增 ${report.added} 条、更新 ${report.updated} 条，当前共 ${report.total} 条。`,
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
        { text: '覆盖现有', style: 'destructive', onPress: () => doImport(result.logs, 'replace') },
        { text: '合并去重', onPress: () => doImport(result.logs, 'merge') },
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

  const [exportState, setExportState] = useState('idle'); 
  const exportFadeAnim = useRef(new Animated.Value(0)).current;

  const handleExport = () => {
    setExportState('exporting');
    Animated.timing(exportFadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    setTimeout(() => {
      setExportState('success');
      setTimeout(() => {
        Animated.timing(exportFadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => setExportState('idle'));
      }, 1500);
    }, 2000);
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState([]);
  const [yearFilters, setYearFilters] = useState([]);
  const [monthFilters, setMonthFilters] = useState([]);
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

  const availableYears = useMemo(() => {
    const years = new Set(logData.map(item => item.date.substring(0, 4)));
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [logData]);

  const handleYearToggle = (y) => {
    setYearFilters(prev => {
      const next = prev.includes(y) ? prev.filter(x => x !== y) : [...prev, y];
      if (next.length !== 1) setMonthFilters([]);
      return next;
    });
  };

  const filteredAndSortedData = useMemo(() => {
    let result = [...logData];
    if (searchQuery.trim().length > 0) {
      const lowerQuery = searchQuery.toLowerCase();
      result = result.filter(item => (item.title && item.title.toLowerCase().includes(lowerQuery)) || (item.subtitle && item.subtitle.toLowerCase().includes(lowerQuery)));
    }
    if (activeFilters.length > 0) {
      result = result.filter(item => activeFilters.includes(item.subType) || activeFilters.includes(item.baseType));
    }
    if (yearFilters.length > 0) {
      result = result.filter(item => yearFilters.includes(item.date.substring(0, 4)));
    }
    if (yearFilters.length === 1 && monthFilters.length > 0) {
      result = result.filter(item => monthFilters.includes(item.date.substring(5, 7))); 
    }
    result.sort((a, b) => new Date(b.date) - new Date(a.date));
    return result;
  }, [logData, activeFilters, yearFilters, monthFilters, searchQuery]);

  const mapHtml = useMemo(() => {
    const markersData = filteredAndSortedData.filter(item => item.coordinates);
    return `
      <!DOCTYPE html>
      <html>
      <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
          <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
          <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
          <style>body { padding: 0; margin: 0; background-color: #F2F2F7; } html, body, #map { height: 100%; width: 100%; } .leaflet-control-attribution { display: none; }</style>
      </head>
      <body>
          <div id="map"></div>
          <script>
              const map = L.map('map', { zoomControl: false }).setView([34.0, 108.0], 4);
              L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
              const rawData = ${JSON.stringify(markersData)};
              const latlngs = [];
              rawData.forEach(item => {
                  const latlng = [item.coordinates.latitude, item.coordinates.longitude];
                  latlngs.push(latlng);
                  L.marker(latlng).addTo(map).bindPopup('<b>' + item.title + '</b><br>' + (item.subtitle || ''));
              });
              if (latlngs.length > 1) {
                  const polyline = L.polyline(latlngs, { color: '#007AFF', weight: 3, dashArray: '5, 8' }).addTo(map);
                  map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
              } else if (latlngs.length === 1) {
                  map.setView(latlngs[0], 10);
              }
          </script>
      </body>
      </html>
    `;
  }, [filteredAndSortedData]);

  const confirmDelete = (item) => {
    Alert.alert('删除印记', `确定要删除「${item.title}」吗？删除后无法恢复。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => deleteLog(item.id) },
    ]);
  };

  const renderItem = ({ item, index }) => {
    const isLast = index === filteredAndSortedData.length - 1;

    // 右滑露出操作按钮；点击后先收起滑动，再执行
    const renderRightActions = (_progress, drag, swipeable) => (
      <SwipeRightActions
        drag={drag}
        onEdit={() => { swipeable.close(); navigation.navigate('Edit', { editItem: item }); }}
        onDelete={() => { swipeable.close(); confirmDelete(item); }}
      />
    );

    return (
      <ReanimatedSwipeable
        renderRightActions={renderRightActions}
        overshootRight={false}
        friction={2}
      >
        <PressableScale style={styles.cardRow} onPress={() => navigation.navigate('Detail', { item })}>
          <View style={[styles.cardItem, !isLast && styles.cardItemBorder]}>
            <CoverIcon item={item} />
            <View style={styles.itemContent}>
              <View style={styles.itemHeader}>
                <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.itemDate}>{item.date.replace(/^\d{4}-/, '')}</Text>
              </View>
              <View style={styles.starContainer}>
                {[1, 2, 3, 4, 5].map((i) => {
                  const isFull = i <= item.rating;
                  const isHalf = i === Math.ceil(item.rating) && !Number.isInteger(item.rating);
                  if (!item.rating) return null;
                  if (isHalf) return <StarHalf key={i} size={12} color="#FACC15" fill="#FACC15" style={{ marginRight: 2 }} />;
                  return <Star key={i} size={12} color={isFull ? "#FACC15" : "#E5E7EB"} fill={isFull ? "#FACC15" : "transparent"} style={{ marginRight: 2 }} />;
                })}
              </View>
              {!!item.subtitle && <Text style={styles.itemSubtitle} numberOfLines={2}>{item.subtitle}</Text>}
            </View>
          </View>
        </PressableScale>
      </ReanimatedSwipeable>
    );
  };

  return (
    <View style={styles.container}>

      {isSidebarOpen && (
        <Animated.View style={[styles.sidebarOverlay, { opacity: overlayAnim }]}>
          <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={() => toggleSidebar(false)} />
        </Animated.View>
      )}
      <Animated.View style={[styles.sidebar, { transform: [{ translateX: sidebarAnim }] }]}>
        <View style={[styles.sidebarContent, { paddingTop: insets.top + 20 }]}>
          <View style={styles.sidebarHeader}><View style={styles.largeAvatar}><User color="#FFF" size={40} /></View><Text style={styles.userName}>旅行者</Text></View>
          <View style={styles.statsRow}>
            <View style={styles.statItem}><Text style={styles.statNum}>{logData.length}</Text><Text style={styles.statLabel}>总印记</Text></View>
          </View>
          <View style={styles.sidebarMenu}>
            <TouchableOpacity style={styles.menuItem} onPress={handleSync} disabled={syncing}>
              <RefreshCw size={18} color="#4B5563" style={{ marginRight: 10 }} />
              <Text style={styles.menuItemText}>{syncing ? '正在同步…' : '同步相册影像'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleExportBackup}>
              <Upload size={18} color="#4B5563" style={{ marginRight: 10 }} />
              <Text style={styles.menuItemText}>导出备份</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleImportBackup}>
              <Download size={18} color="#4B5563" style={{ marginRight: 10 }} />
              <Text style={styles.menuItemText}>导入备份</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleCleanCache}>
              <Eraser size={18} color="#4B5563" style={{ marginRight: 10 }} />
              <Text style={styles.menuItemText}>清理缓存</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Animated.View>

      <View style={[styles.mainContent, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.profileBtn} onPress={() => toggleSidebar(true)}><User color="#FFF" size={20} /></TouchableOpacity>
          <View style={styles.segmentedControl}>
            <TouchableOpacity style={[styles.segmentBtn, viewMode === 'list' && styles.segmentBtnActive]} onPress={() => setViewMode('list')}><Text style={[styles.segmentText, viewMode === 'list' && styles.segmentTextActive]}>列表</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.segmentBtn, viewMode === 'map' && styles.segmentBtnActive]} onPress={() => setViewMode('map')}><Text style={[styles.segmentText, viewMode === 'map' && styles.segmentTextActive]}>地图</Text></TouchableOpacity>
          </View>
          <View style={{ width: 36 }} /> 
        </View>

        <Text style={styles.largeTitle}>印记</Text>

        {viewMode === 'list' && (
          <View style={styles.filterBar}>
            <View style={styles.searchContainer}>
              <Search size={16} color="#9CA3AF" style={{ marginRight: 6 }} />
              <TextInput style={styles.searchInput} placeholder="搜索标题、关键字..." value={searchQuery} onChangeText={setSearchQuery} placeholderTextColor="#9CA3AF" />
              {searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery('')}><X size={16} color="#9CA3AF" /></TouchableOpacity>}
            </View>
            <TouchableOpacity style={[styles.filterBtn, (activeFilters.length > 0 || yearFilters.length > 0 || monthFilters.length > 0) ? styles.filterBtnActive : null]} onPress={() => filterSheetRef.current?.present()}>
              <ListFilter size={16} color={(activeFilters.length > 0 || yearFilters.length > 0 || monthFilters.length > 0) ? "#007AFF" : "#4B5563"} />
              {(activeFilters.length > 0 || yearFilters.length > 0 || monthFilters.length > 0) && <View style={styles.filterDot} />}
            </TouchableOpacity>
          </View>
        )}

        {viewMode === 'list' ? (
          <View style={styles.listWrapper}>
            {/* 首页列表整体淡入，避免进入页面时的生硬闪现 */}
            <Reanimated.View entering={FadeIn.duration(250)} style={{ flex: 1 }}>
              <FlatList
                data={filteredAndSortedData}
                keyExtractor={(item) => item.id.toString()}
                renderItem={renderItem}
                showsVerticalScrollIndicator={false}
              />
            </Reanimated.View>
          </View>
        ) : (
          <View style={styles.mapWrapper}>
            <WebView originWhitelist={['*']} source={{ html: mapHtml }} style={styles.map} scrollEnabled={false} />
            <TouchableOpacity style={[styles.exportBtn, { bottom: 20 }]} onPress={handleExport}><Share2 color="#FFF" size={20} /><Text style={styles.exportBtnText}>导出轨迹</Text></TouchableOpacity>
          </View>
        )}
      </View>

      <BottomSheetModal
        ref={filterSheetRef}
        index={0}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        animationConfigs={{ damping: 24, stiffness: 220, mass: 0.9 }}
        onChange={(index) => setSheetOpen(index != null && index >= 0)}
        onDismiss={() => setSheetOpen(false)}
      >
        <BottomSheetView style={styles.sheetHeader}>
          <BottomSheetTouchableOpacity onPress={() => {setActiveFilters([]); setYearFilters([]); setMonthFilters([]);}} style={styles.headerHitSlop}><Text style={styles.sheetBtnTextGray}>重置</Text></BottomSheetTouchableOpacity>
          <Text style={styles.sheetTitle}>筛选</Text>
          <BottomSheetTouchableOpacity onPress={() => filterSheetRef.current?.dismiss()} style={styles.headerHitSlop}><Text style={styles.sheetBtnTextBlue}>完成</Text></BottomSheetTouchableOpacity>
        </BottomSheetView>
        <BottomSheetScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.categoryTitle}>时间</Text>
          <Text style={styles.sectionTitle}>年份</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.horizontalScroll}>
            {availableYears.map(y => (<BottomSheetTouchableOpacity key={y} onPress={() => handleYearToggle(y)} style={[styles.chip, yearFilters.includes(y) && styles.chipActive]}><Text style={[styles.chipText, yearFilters.includes(y) && styles.chipTextActive]}>{y}年</Text></BottomSheetTouchableOpacity>))}
          </ScrollView>
          {yearFilters.length === 1 && (
            <View style={styles.monthSection}>
              <Text style={styles.sectionTitle}>月份</Text>
              <View style={styles.chipGrid}>
                {['01','02','03','04','05','06','07','08','09','10','11','12'].map(m => (<BottomSheetTouchableOpacity key={m} onPress={() => setMonthFilters(prev => monthFilters.includes(m) ? prev.filter(x => x !== m) : [...prev, m])} style={[styles.chip, monthFilters.includes(m) && styles.chipActive]}><Text style={[styles.chipText, monthFilters.includes(m) && styles.chipTextActive]}>{parseInt(m)}月</Text></BottomSheetTouchableOpacity>))}
                <BottomSheetTouchableOpacity onPress={() => setMonthFilters([])} style={[styles.chip, monthFilters.length === 0 && styles.chipActive]}><Text style={[styles.chipText, monthFilters.length === 0 && styles.chipTextActive]}>全年</Text></BottomSheetTouchableOpacity>
              </View>
            </View>
          )}
          <View style={styles.divider} />
          <Text style={styles.categoryTitle}>记录类型</Text>
          <Text style={styles.sectionTitle}>旅票</Text>
          <View style={styles.chipGrid}>
            {subTypeOptions.ticket.map(sub => (<BottomSheetTouchableOpacity key={sub.id} onPress={() => setActiveFilters(prev => activeFilters.includes(sub.id) ? prev.filter(f => f !== sub.id) : [...prev, sub.id])} style={[styles.chip, activeFilters.includes(sub.id) && styles.chipActive]}>{activeFilters.includes(sub.id) && <Check size={15} color="#007AFF" style={styles.checkIcon}/>}<Text style={[styles.chipText, activeFilters.includes(sub.id) && styles.chipTextActive]}>{sub.label}</Text></BottomSheetTouchableOpacity>))}
          </View>
          <Text style={styles.sectionTitle}>地点</Text>
          <View style={styles.chipGrid}>
            <BottomSheetTouchableOpacity onPress={() => setActiveFilters(prev => prev.includes('location') ? prev.filter(f => f !== 'location') : [...prev, 'location'])} style={[styles.chip, activeFilters.includes('location') && styles.chipActiveRed]}>{activeFilters.includes('location') && <Check size={15} color="#EF4444" style={styles.checkIcon}/>}<Text style={[styles.chipText, activeFilters.includes('location') && styles.chipTextActiveRed]}>地点</Text></BottomSheetTouchableOpacity>
          </View>
          <Text style={styles.sectionTitle}>娱乐与阅读</Text>
          <View style={styles.chipGrid}>
            {subTypeOptions.media.map(sub => (<BottomSheetTouchableOpacity key={sub.id} onPress={() => setActiveFilters(prev => activeFilters.includes(sub.id) ? prev.filter(f => f !== sub.id) : [...prev, sub.id])} style={[styles.chip, activeFilters.includes(sub.id) && styles.chipActivePurple]}>{activeFilters.includes(sub.id) && <Check size={15} color="#A855F7" style={styles.checkIcon}/>}<Text style={[styles.chipText, activeFilters.includes(sub.id) && styles.chipTextActivePurple]}>{sub.label}</Text></BottomSheetTouchableOpacity>))}
          </View>
        </BottomSheetScrollView>
      </BottomSheetModal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  mainContent: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, height: 44 },
  profileBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#007AFF', justifyContent: 'center', alignItems: 'center' },
  largeTitle: { fontSize: 34, fontWeight: 'bold', paddingHorizontal: 16, marginTop: 10, marginBottom: 10, color: '#000' },
  segmentedControl: { flexDirection: 'row', backgroundColor: '#E5E5EA', borderRadius: 8, padding: 2, width: 140 },
  segmentBtn: { flex: 1, paddingVertical: 6, alignItems: 'center', borderRadius: 6 },
  segmentBtnActive: { backgroundColor: '#FFF', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1 },
  segmentText: { fontSize: 13, color: '#8E8E93', fontWeight: '500' },
  segmentTextActive: { color: '#000' },
  filterBar: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 8, alignItems: 'center' },
  searchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#E5E5EA', borderRadius: 10, paddingHorizontal: 10, height: 36, marginRight: 10 },
  searchInput: { flex: 1, fontSize: 14, color: '#1C1C1E', paddingVertical: 0 },
  filterBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#E5E5EA', justifyContent: 'center', alignItems: 'center' },
  filterBtnActive: { backgroundColor: '#E0F2FE' },
  filterDot: { position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: 3, backgroundColor: '#EF4444' },
  listWrapper: { flex: 1, backgroundColor: '#FFF', marginHorizontal: 16, marginTop: 4, marginBottom: 20, borderRadius: 14, overflow: 'hidden' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 14, color: '#9CA3AF' },
  cardItem: { flexDirection: 'row', padding: 16 },
  cardItemBorder: { borderBottomWidth: 1, borderBottomColor: '#F2F2F7' },
  itemContent: { flex: 1, justifyContent: 'center' },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
  itemTitle: { fontSize: 16, fontWeight: '600', color: '#1C1C1E', flex: 1, marginRight: 8 },
  itemDate: { fontSize: 12, color: '#8E8E93' },
  starContainer: { flexDirection: 'row', marginBottom: 4 },
  itemSubtitle: { fontSize: 14, color: '#8E8E93', lineHeight: 18 },

  swipeActions: { flexDirection: 'row', alignItems: 'stretch', width: SWIPE_ACTIONS_WIDTH },
  swipeBtn: { width: 72, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeEditBtn: { backgroundColor: '#007AFF' },
  swipeDeleteBtn: { backgroundColor: '#EF4444' },
  swipeBtnText: { color: '#FFF', fontSize: 12, fontWeight: '600' },
  cardRow: { backgroundColor: '#FFF' },

  mapWrapper: { flex: 1, marginTop: 4, marginHorizontal: 16, marginBottom: 20, borderRadius: 14, overflow: 'hidden' },
  map: { flex: 1 },
  exportBtn: { position: 'absolute', right: 20, backgroundColor: '#1C1C1E', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 25 },
  exportBtnText: { color: '#FFF', marginLeft: 8, fontWeight: '600' },
  sidebarOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 99 },
  sidebar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: SCREEN_WIDTH * 0.5, backgroundColor: '#FFF', zIndex: 100 },
  sidebarContent: { flex: 1, paddingHorizontal: 20 },
  sidebarHeader: { alignItems: 'center', marginBottom: 30 },
  largeAvatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#007AFF', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  userName: { fontSize: 18, fontWeight: 'bold', color: '#1C1C1E' },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 30 },
  statItem: { alignItems: 'center' },
  statNum: { fontSize: 20, fontWeight: 'bold', color: '#1C1C1E' },
  statLabel: { fontSize: 12, color: '#8E8E93', marginTop: 4 },
  sidebarMenu: { borderTopWidth: 1, borderTopColor: '#F2F2F7', paddingTop: 10 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#F2F2F7' },
  menuItemText: { fontSize: 16, color: '#1C1C1E' },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F3F4F6', backgroundColor: '#FFFFFF', zIndex: 10 },
  headerHitSlop: { padding: 10, margin: -10 },
  sheetTitle: { fontSize: 17, fontWeight: '600', color: '#1C1C1E' },
  sheetBtnTextGray: { fontSize: 16, color: '#6B7280' },
  sheetBtnTextBlue: { fontSize: 16, fontWeight: '600', color: '#007AFF' },
  sheetScroll: { flex: 1, paddingHorizontal: 20, paddingTop: 10 },
  categoryTitle: { fontSize: 18, fontWeight: 'bold', color: '#1C1C1E', marginTop: 12, marginBottom: 4 },
  sectionTitle: { fontSize: 13, fontWeight: '500', color: '#9CA3AF', marginBottom: 12, marginTop: 8 },
  horizontalScroll: { flexDirection: 'row', marginBottom: 20 },
  monthSection: { marginBottom: 20 },
  divider: { height: 1, backgroundColor: '#E5E7EB', marginVertical: 16 },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20 },
  chip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 36, backgroundColor: '#F9FAFB', paddingHorizontal: 16, borderRadius: 18, borderWidth: 1, borderColor: '#F3F4F6', marginRight: 10, marginBottom: 10 },
  chipText: { fontSize: 14, color: '#4B5563' },
  checkIcon: { marginRight: 4, marginTop: 1 }, 
  chipActive: { backgroundColor: '#E0F2FE', borderColor: '#BAE6FD' },
  chipTextActive: { color: '#007AFF', fontWeight: '500' },
  chipActiveRed: { backgroundColor: '#FEE2E2', borderColor: '#FECACA' },
  chipTextActiveRed: { color: '#EF4444', fontWeight: '500' },
  chipActivePurple: { backgroundColor: '#F3E8FF', borderColor: '#E9D5FF' },
  chipTextActivePurple: { color: '#A855F7', fontWeight: '500' },
});