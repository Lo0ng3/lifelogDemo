import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  Dimensions, Animated, TextInput, Alert, BackHandler, ToastAndroid, Platform, Modal
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  User, Star, StarHalf, ListFilter, Check, Search, X, Edit3, Trash2, RefreshCw, Upload, Download, Eraser, Settings
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
import { shortTicketTitle, shortPlaceName } from '../utils/format';

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

// 列表行组件（memo 化）：搜索输入、侧边栏开合等父级重渲染不会重刷整列表。
// 删除确认放在行内，依赖的 deleteLog 从 context 读取
const ListRow = React.memo(function ListRow({ item, isLast, navigation }) {
  const { deleteLog } = useContext(LogContext);
  const renderRightActions = (_progress, drag, swipeable) => (
    <SwipeRightActions
      drag={drag}
      onEdit={() => { swipeable.close(); navigation.navigate('Edit', { editItem: item }); }}
      onDelete={() => {
        swipeable.close();
        Alert.alert('删除印记', `确定要删除「${item.title}」吗？删除后无法恢复。`, [
          { text: '取消', style: 'cancel' },
          { text: '删除', style: 'destructive', onPress: () => deleteLog(item.id) },
        ]);
      }}
    />
  );
  return (
    <ReanimatedSwipeable renderRightActions={renderRightActions} overshootRight={false} friction={2}>
      <PressableScale style={styles.cardRow} onPress={() => navigation.navigate('Detail', { item })}>
        <View style={[styles.cardItem, !isLast && styles.cardItemBorder]}>
          <CoverIcon item={item} height={64} />
          <View style={styles.itemContent}>
            <View style={styles.itemHeader}>
              <Text style={styles.itemTitle} numberOfLines={1}>{shortTicketTitle(item.title)}</Text>
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
            {!!item.comment && <Text style={styles.itemSubtitle} numberOfLines={2}>{item.comment}</Text>}
          </View>
        </View>
      </PressableScale>
    </ReanimatedSwipeable>
  );
});

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { logData, syncMedia, importLogs, tdtKey, setTdtKey } = useContext(LogContext);

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
      result = result.filter(item => (item.title && item.title.toLowerCase().includes(lowerQuery)) || (item.subtitle && item.subtitle.toLowerCase().includes(lowerQuery)) || (item.comment && item.comment.toLowerCase().includes(lowerQuery)));
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
    // 打点：地点用 coordinates；旅票用 start/end（坐标缺失的记录跳过）
    const points = [];
    filteredAndSortedData.forEach(item => {
      const note = item.comment || item.subtitle || '';
      if (item.coordinates && item.coordinates.latitude != null) {
        points.push({ kind: 'location', title: item.title, date: item.date, note, lat: item.coordinates.latitude, lng: item.coordinates.longitude });
      }
      [item.start, item.end].forEach(p => {
        if (p && p.latitude != null && p.longitude != null) {
          points.push({ kind: 'ticket', subType: item.subType, title: shortPlaceName(p.name || item.title), date: item.date, note, lat: p.latitude, lng: p.longitude });
        }
      });
    });
    // 轨迹段：按 出发地→目的地 聚合（单向），往返分居弧线两侧，粗细 = 次数。
    // 分段键用坐标而不是名称：同一段被改成不同别名后仍算同一条线
    const segMap = new Map();
    filteredAndSortedData
      .filter(item => item.baseType === 'ticket' && item.start && item.end && item.start.latitude != null && item.end.latitude != null)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .forEach(t => {
        const key = [t.start, t.end].map(p => p.longitude.toFixed(4) + ',' + p.latitude.toFixed(4)).join('→');
        if (!segMap.has(key)) segMap.set(key, { from: t.start, to: t.end, count: 0, subType: t.subType });
        const seg = segMap.get(key);
        seg.count++;
        seg.from = t.start; seg.to = t.end;   // 显示名称取最近一次的别名
      });
    const segs = [...segMap.values()];
    // 嵌入 WebView 的 JSON 要转义 "<"，防止用户内容提前闭合 script 标签
    const safeJson = v => JSON.stringify(v).replace(/</g, '\\u003c');
    return `
      <!DOCTYPE html>
      <html>
      <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css" />
          <script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>
          <style>
              body { padding: 0; margin: 0; background-color: #F2F2F7; } html, body, #map { height: 100%; width: 100%; }
              .leaflet-control-attribution { display: none; }
              .pin { width: 18px; height: 18px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); border: 2px solid #FFF; box-shadow: 0 2px 5px rgba(0,0,0,.3); }
              .pin::after { content: ""; position: absolute; inset: 4px; background: #FFF; border-radius: 50%; }
              .cntBadge { width: 22px; height: 22px; border-radius: 11px; background: #FFF; border: 2px solid #007AFF; color: #007AFF; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; font-family: sans-serif; }
              .zoomCtl { position: absolute; right: 12px; top: 12px; z-index: 900; display: flex; flex-direction: column; background: #FFF; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.15); overflow: hidden; }
              .zoomCtl button { width: 36px; height: 36px; border: none; background: transparent; font-size: 16px; color: #374151; cursor: pointer; font-family: sans-serif; }
              .zoomCtl button + button { border-top: 1px solid #F3F4F6; }
              .trajCtl { position: absolute; right: 12px; top: 126px; z-index: 900; background: #FFF; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
              .trajCtl button { display: block; width: 36px; height: 36px; border: none; background: transparent; font-size: 12px; color: #374151; cursor: pointer; font-family: sans-serif; }
              .banner { position: absolute; top: 0; left: 0; right: 0; z-index: 950; background: #FFF7E6; color: #8a6d3b; font: 12px/1.6 sans-serif; padding: 6px 10px; }
          </style>
      </head>
      <body>
          <div id="map"></div>
          ${tdtKey ? '' : '<div class="banner">未配置天地图 Key，可在侧边栏「地图服务 Key」中填写</div>'}
          <div class="zoomCtl">
              <button id="zin">＋</button><button id="zout">－</button><button id="zfit">⌂</button>
          </div>
          <div class="trajCtl"><button id="trajBtn">轨迹</button></div>
          <script>
              var POINTS = ${safeJson(points)};
              var SEGS = ${safeJson(segs)};
              var TK = ${safeJson(tdtKey)};
              var COLORS = { flight: '#2F7BF6', train: '#10B981', bus: '#F97316', ship: '#8B5CF6' };
              function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
              var map = L.map('map', { zoomControl: false }).setView([34.0, 108.0], 4);
              map.attributionControl.setPrefix('');
              if (TK) {
                  L.tileLayer('https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk=' + TK, { subdomains: '01234567', maxZoom: 18 }).addTo(map);
                  L.tileLayer('https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&x={x}&y={y}&l={z}&tk=' + TK, { subdomains: '01234567', maxZoom: 18 }).addTo(map);
              }
              var trajLayer = L.layerGroup().addTo(map);
              var trajOn = true;
              function pinIcon(color) { return L.divIcon({ className: '', html: '<div class="pin" style="margin:4px;background:' + color + '"></div>', iconSize: [26, 26], iconAnchor: [13, 23] }); }
              function addMarker(p) {
                  var color = p.kind === 'location' ? '#EE4D3D' : (COLORS[p.subType] || '#2F7BF6');
                  return L.marker([p.lat, p.lng], { icon: pinIcon(color) })
                      .bindPopup('<b>' + esc(p.title) + '</b><br><span style="color:#8E8E93;font-size:12px">' + esc(p.date) + '</span>' + (p.note ? '<br>' + esc(p.note) : ''), { closeButton: false, offset: [0, -12] });
              }
              // 地点标点常驻；旅票的出发/到达标点跟随轨迹开关
              POINTS.forEach(function (p) { if (p.kind === 'location') addMarker(p).addTo(map); });
              function drawTraj() {
                  trajLayer.clearLayers();
                  POINTS.forEach(function (p) { if (p.kind === 'ticket') addMarker(p).addTo(trajLayer); });
                  SEGS.forEach(function (seg) {
                      var color = COLORS[seg.subType] || '#007AFF';
                      var A = [seg.from.longitude, seg.from.latitude], B = [seg.to.longitude, seg.to.latitude];
                      var dx = B[0] - A[0], dy = B[1] - A[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
                      var bend = Math.min(1.6, Math.max(0.12, len * 0.14));
                      var C = [(A[0] + B[0]) / 2 + dy / len * bend, (A[1] + B[1]) / 2 - dx / len * bend];
                      var path = [];
                      for (var i = 0; i <= 28; i++) {
                          var t = i / 28, u = 1 - t;
                          path.push([u * u * A[1] + 2 * u * t * C[1] + t * t * B[1], u * u * A[0] + 2 * u * t * C[0] + t * t * B[0]]);
                      }
                      L.polyline(path, { color: color, weight: Math.min(9, 3 + (seg.count - 1) * 1.8), opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(trajLayer);
                      if (seg.count > 1) {
                          L.marker(path[14], { icon: L.divIcon({ className: '', html: '<div class="cntBadge" style="border-color:' + color + ';color:' + color + '">×' + seg.count + '</div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(trajLayer);
                      }
                  });
              }
              var trajBtn = document.getElementById('trajBtn');
              function renderTraj() { if (trajOn) drawTraj(); else trajLayer.clearLayers(); trajBtn.textContent = trajOn ? '轨迹·开' : '轨迹·关'; }
              renderTraj();
              trajBtn.onclick = function () { trajOn = !trajOn; renderTraj(); };
              document.getElementById('zin').onclick = function () { map.zoomIn(); };
              document.getElementById('zout').onclick = function () { map.zoomOut(); };
              document.getElementById('zfit').onclick = function () {
                  var lls = POINTS.map(function (p) { return [p.lat, p.lng]; });
                  SEGS.forEach(function (s) { lls.push([s.from.latitude, s.from.longitude], [s.to.latitude, s.to.longitude]); });
                  if (lls.length) map.fitBounds(lls, { padding: [30, 30] });
              };
              if (POINTS.length || SEGS.length) setTimeout(function () { document.getElementById('zfit').onclick(); }, 400);
              window.onresize = function () { map.invalidateSize(); };
          </script>
      </body>
      </html>
    `;
  }, [filteredAndSortedData, tdtKey]);

  const renderItem = useCallback(({ item, index }) => (
    <ListRow
      item={item}
      isLast={index === filteredAndSortedData.length - 1}
      navigation={navigation}
    />
  ), [filteredAndSortedData.length, navigation]);

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
            <TouchableOpacity style={styles.menuItem} onPress={openSettings}>
              <Settings size={18} color="#4B5563" style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.menuItemText}>地图服务 Key</Text>
                <Text style={styles.menuItemSub}>{tdtKey ? '天地图服务已配置' : '未配置，地图与联想不可用'}</Text>
              </View>
            </TouchableOpacity>
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

        {/* 列表与地图都保持挂载，仅切换显示：地图瓦片不因切页而重新下载 */}
        <View style={[styles.listWrapper, viewMode !== 'list' && styles.hiddenView]}>
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
        <View style={[styles.mapWrapper, viewMode !== 'map' && styles.hiddenView]}>
          <WebView originWhitelist={['*']} source={{ html: mapHtml }} style={styles.map} scrollEnabled={false} />
        </View>
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
              placeholderTextColor="#9CA3AF"
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
  hiddenView: { display: 'none' },
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
  menuItemSub: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  settingsOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', padding: 32 },
  settingsCard: { width: '100%', backgroundColor: '#FFF', borderRadius: 14, padding: 18 },
  settingsTitle: { fontSize: 17, fontWeight: '600', color: '#1C1C1E', marginBottom: 14 },
  settingsLabel: { fontSize: 13, fontWeight: '500', color: '#9CA3AF', marginBottom: 8 },
  settingsInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, backgroundColor: '#F9FAFB', paddingHorizontal: 12, height: 44, fontSize: 14, color: '#1C1C1E' },
  settingsHint: { fontSize: 12, color: '#9CA3AF', lineHeight: 18, marginTop: 8 },
  settingsBtnRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  settingsBtn: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 8, marginLeft: 10 },
  settingsBtnCancel: { backgroundColor: '#F3F4F6' },
  settingsBtnCancelText: { fontSize: 14, color: '#6B7280' },
  settingsBtnSave: { backgroundColor: '#007AFF' },
  settingsBtnSaveText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
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