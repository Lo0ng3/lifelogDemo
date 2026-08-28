import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  Dimensions, Animated, TextInput
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  User, Star, StarHalf, ListFilter, Check, Share2, Search, X
} from 'lucide-react-native';
import { WebView } from 'react-native-webview';

import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTouchableOpacity
} from '@gorhom/bottom-sheet';

import { LogContext } from '../context/LogContext';
import { getIconConfig } from '../utils/icons';
import { resolveMediaUri } from '../utils/media';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const subTypeOptions = {
  ticket: [{ id: 'flight', label: '机票' }, { id: 'train', label: '火车票' }, { id: 'bus', label: '汽车票' }, { id: 'ship', label: '轮船' }],
  media: [{ id: 'movie', label: '电影' }, { id: 'tv', label: '剧集' }, { id: 'anime', label: '动漫' }, { id: 'game', label: '游戏' }, { id: 'book', label: '书籍' }]
};

// 列表左侧：设过封面（coverIndex）的记录显示那张图，其次显示已下载的网络海报，都没有则显示类型图标
function CoverIcon({ item }) {
  const { IconComponent, iconColor, iconBgColor } = getIconConfig(item);
  const entry = item.coverIndex != null ? item.localImages?.[item.coverIndex] : null;
  const [uri, setUri] = useState(null);
  useEffect(() => {
    let alive = true;
    if (entry) resolveMediaUri(entry).then(u => { if (alive) setUri(u); });
    return () => { alive = false; };
  }, [entry]);
  const src = uri || item.coverUrl;
  if (src) {
    return <Image source={{ uri: src }} style={styles.iconBox} contentFit="cover" transition={150} cachePolicy="memory-disk" />;
  }
  return (
    <View style={[styles.iconBox, { backgroundColor: iconBgColor }]}>
      <IconComponent color={iconColor} size={22} />
    </View>
  );
}

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { logData } = useContext(LogContext);
  
  const [viewMode, setViewMode] = useState('list'); 
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const sidebarAnim = useRef(new Animated.Value(-SCREEN_WIDTH * 0.5)).current;

  const toggleSidebar = (open) => {
    setIsSidebarOpen(open);
    Animated.spring(sidebarAnim, { 
      toValue: open ? 0 : -SCREEN_WIDTH * 0.5, 
      useNativeDriver: true, 
      stiffness: 150,  // ✨ 增加刚度，让弹出更迅速
      damping: 20,     // ✨ 增加阻尼，消除回弹的抖动
      mass: 0.8        // ✨ 减轻质量，让动画看起来更轻盈
    }).start();
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

  const renderItem = ({ item, index }) => {
    const isLast = index === filteredAndSortedData.length - 1;

    return (
      <TouchableOpacity activeOpacity={0.7} onPress={() => navigation.navigate('Detail', { item })}>
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
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>

      {isSidebarOpen && <TouchableOpacity activeOpacity={1} style={styles.sidebarOverlay} onPress={() => toggleSidebar(false)} />}
      <Animated.View style={[styles.sidebar, { transform: [{ translateX: sidebarAnim }] }]}>
        <View style={[styles.sidebarContent, { paddingTop: insets.top + 20 }]}>
          <View style={styles.sidebarHeader}><View style={styles.largeAvatar}><User color="#FFF" size={40} /></View><Text style={styles.userName}>旅行者</Text></View>
          <View style={styles.statsRow}>
            <View style={styles.statItem}><Text style={styles.statNum}>{logData.length}</Text><Text style={styles.statLabel}>总印记</Text></View>
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
            <FlatList 
              data={filteredAndSortedData} 
              keyExtractor={(item) => item.id.toString()} 
              renderItem={renderItem}
              showsVerticalScrollIndicator={false} 
            />
          </View>
        ) : (
          <View style={styles.mapWrapper}>
            <WebView originWhitelist={['*']} source={{ html: mapHtml }} style={styles.map} scrollEnabled={false} />
            <TouchableOpacity style={[styles.exportBtn, { bottom: 20 }]} onPress={handleExport}><Share2 color="#FFF" size={20} /><Text style={styles.exportBtnText}>导出轨迹</Text></TouchableOpacity>
          </View>
        )}
      </View>

      <BottomSheetModal ref={filterSheetRef} index={0} snapPoints={snapPoints} backdropComponent={renderBackdrop}>
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
  iconBox: { width: 44, height: 44, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  itemContent: { flex: 1, justifyContent: 'center' },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
  itemTitle: { fontSize: 16, fontWeight: '600', color: '#1C1C1E', flex: 1, marginRight: 8 },
  itemDate: { fontSize: 12, color: '#8E8E93' },
  starContainer: { flexDirection: 'row', marginBottom: 4 },
  itemSubtitle: { fontSize: 14, color: '#8E8E93', lineHeight: 18 },

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
  menuItem: { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#F2F2F7' },
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