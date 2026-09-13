import React, { useState, useEffect, useContext, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, KeyboardAvoidingView, Platform, Image, Alert, ActivityIndicator,
  BackHandler, ToastAndroid
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Plane, MapPin, Film, Search, ImagePlus, X, Star, StarHalf, ChevronRight, PlayCircle
} from 'lucide-react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { mediaUri, normalizeMediaEntry, resolveMediaUri, downloadRemoteCover, getVideoThumbnail, isAppOwnedMediaPath, isVideoEntry } from '../utils/media';
import { relinkNewEntries } from '../utils/mediaSync';
import Reanimated, { FadeIn } from 'react-native-reanimated';
import { LogContext } from '../context/LogContext';
import { fetchSuggestions, fetchPlaceSuggestions, fetchPlaceGeocode, hasLocationSearch } from '../utils/search';

// 二级类型选择：第一级大类 → 第二级子类；地点无子类
const BASE_LABEL = { ticket: '旅票', location: '地点', media: '娱乐' };
const SUB_OPTIONS = {
  ticket: [{ id: 'flight', label: '机票' }, { id: 'train', label: '火车票' }, { id: 'bus', label: '汽车票' }, { id: 'ship', label: '轮船' }],
  media: [{ id: 'movie', label: '电影' }, { id: 'tv', label: '剧集' }, { id: 'anime', label: '动漫' }, { id: 'game', label: '游戏' }, { id: 'book', label: '书籍' }],
};
const SUB_LABEL = { flight: '机票', train: '火车票', bus: '汽车票', ship: '轮船', movie: '电影', tv: '剧集', anime: '动漫', game: '游戏', book: '书籍' };
const TICKET_NO_LABEL = { flight: '航班号', train: '车次', bus: '班次', ship: '班次' };

// 联想词条：标题 + 作者/年份，自然换行展示
function SuggestionRow({ title, meta, onPress, textStyle, metaStyle }) {
  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity onPress={onPress}>
        <Text style={textStyle}>{title}</Text>
        {!!meta && <Text style={metaStyle}>{meta}</Text>}
      </TouchableOpacity>
    </View>
  );
}

// 视频条目的表单预览：Image 放不了视频，用封面帧（落盘缓存）+ 播放角标
function VideoPreview({ entry }) {
  const [thumb, setThumb] = useState(null);
  useEffect(() => {
    let alive = true;
    getVideoThumbnail(entry).then(t => { if (alive && t) setThumb(t); });
    return () => { alive = false; };
  }, [entry]);
  return (
    <View style={styles.imageGridImage}>
      {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
      <View style={styles.playOverlay}><PlayCircle size={18} color="#FFF" /></View>
    </View>
  );
}

export default function AddScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { logData, addLog, updateLog, tdtKey } = useContext(LogContext);
  
  const [editId, setEditId] = useState(null); 
  const [baseType, setBaseType] = useState('ticket'); 
  const [subType, setSubType] = useState('flight');
  
  const [rating, setRating] = useState(0); 
  const [comment, setComment] = useState(''); 
  const [ticketOrigin, setTicketOrigin] = useState('');
  const [ticketDest, setTicketDest] = useState('');
  const [ticketNo, setTicketNo] = useState(''); 
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [hour, setHour] = useState('');
  const [minute, setMinute] = useState('');
  const [selectedImages, setSelectedImages] = useState([]);
  
  // 娱乐类别的网络检索状态
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchAuto, setShowSearchAuto] = useState(false);
  const [searchResults, setSearchResults] = useState([]); // [{ title, meta, artwork }]
  const [isSearching, setIsSearching] = useState(false);
  const [coverUrl, setCoverUrl] = useState(null); // 检索命中后记录的网络封面
  const [coverRatio, setCoverRatio] = useState(null); // 网络封面的宽高比（列表/详情按比例显示）
  const [locationCoords, setLocationCoords] = useState(null); // 地点联想选中的坐标 {lng,lat}
  const [originResults, setOriginResults] = useState([]);     // 旅票出发地联想
  const [showOriginAuto, setShowOriginAuto] = useState(false);
  const [originCoord, setOriginCoord] = useState(null);       // 出发地联想选中的坐标
  const [destResults, setDestResults] = useState([]);         // 旅票目的地联想
  const [showDestAuto, setShowDestAuto] = useState(false);
  const [destCoord, setDestCoord] = useState(null);           // 目的地联想选中的坐标
  const [photoCoord, setPhotoCoord] = useState(null);         // 首张带 GPS 照片的位置（地点坐标兜底）

  const skipNextSearch = useRef(false);
  const skipOriginSearch = useRef(false);
  const skipDestSearch = useRef(false);
  // 联想只在输入框被点入（聚焦）后检索：进入编辑页、路过表单都不会自动弹出
  const [originFocused, setOriginFocused] = useState(false);
  const [destFocused, setDestFocused] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);

  // 类型选择的底部弹层（二级：大类 → 子类）
  const typeSheetRef = useRef(null);
  const [sheetBase, setSheetBase] = useState('ticket'); // 弹层里正在浏览的大类
  const renderTypeBackdrop = useCallback(
    (props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />, []
  );

  const clearForm = () => {
    setEditId(null);
    setRating(0); setComment(''); setTicketOrigin(''); setTicketDest(''); setTicketNo('');
    setYear(''); setMonth(''); setDay(''); setHour(''); setMinute('');
    setSelectedImages([]); setSearchQuery(''); setShowSearchAuto(false);
    setSearchResults([]); setCoverUrl(null); setCoverRatio(null); setLocationCoords(null);
    setOriginResults([]); setShowOriginAuto(false); setOriginCoord(null);
    setDestResults([]); setShowDestAuto(false); setDestCoord(null);
    setPhotoCoord(null);
  };

  // 二级选择的最终结果；切换大类不清空表单，日期/评论/影像等已填内容保留
  const applyType = (base, sub) => {
    setBaseType(base);
    setSubType(sub);
  };

  useEffect(() => {
    if (route.params?.editItem) {
      const item = route.params.editItem;
      setEditId(item.id);
      setBaseType(item.baseType);
      setSubType(item.subType);
      setRating(item.rating || 0);
      setCoverUrl(item.coverUrl || null);
      setCoverRatio(item.coverRatio || null);
      setComment(item.baseType !== 'ticket' ? item.subtitle || '' : item.comment || '');
      // 保存时缓存里的临时拷贝已被清理，编辑时重新从相册解析原始路径用于预览
      Promise.all((item.localImages || []).map(async (e) => {
        const entry = normalizeMediaEntry(e);
        return { ...entry, uri: await resolveMediaUri(entry) };
      })).then((entries) => setSelectedImages(entries));
      
      if (item.baseType === 'ticket') {
        const [origin, dest] = (item.title || ' → ').split(' → ');
        setTicketOrigin(origin ? origin.trim() : '');
        setTicketDest(dest ? dest.trim() : '');
        setTicketNo(item.subtitle || '');
        // 编辑时不自动弹联想；坐标从记录回填，保存时原样带回
        skipOriginSearch.current = true;
        skipDestSearch.current = true;
        setOriginCoord(item.start && item.start.longitude != null ? { lng: item.start.longitude, lat: item.start.latitude } : null);
        setDestCoord(item.end && item.end.longitude != null ? { lng: item.end.longitude, lat: item.end.latitude } : null);
      } else {
        skipNextSearch.current = true;
        setSearchQuery(item.title || '');
      }
      if (item.baseType === 'location' && item.coordinates) {
        setLocationCoords({ lng: item.coordinates.longitude, lat: item.coordinates.latitude });
      }

      const [datePart, timePart] = item.date.split(' ');
      if (datePart) {
        const [y, m, d] = datePart.split('-');
        setYear(y || ''); setMonth(m || ''); setDay(d || '');
      }
      if (timePart) {
        const [h, min] = timePart.split(':');
        setHour(h || ''); setMinute(min || '');
      }
      navigation.setParams({ editItem: null });
    }
  }, [route.params?.editItem]);

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    if (!searchFocused) {
      setSearchResults([]);
      setShowSearchAuto(false);
      return;
    }
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setShowSearchAuto(false);
      return;
    }
    if (baseType !== 'media' && baseType !== 'location') {
      setSearchResults([]);
      setShowSearchAuto(false);
      return;
    }

    const controller = new AbortController();
    const delayDebounceFn = setTimeout(async () => {
      setIsSearching(true);
      setShowSearchAuto(true);

      try {
        let candidates;
        if (baseType === 'location') {
          candidates = await fetchPlaceSuggestions(searchQuery.trim(), tdtKey, controller.signal);
        } else {
          candidates = await fetchSuggestions(searchQuery.trim(), subType, controller.signal);
          // 精确/前缀匹配优先排序，让候选更贴近用户想记的作品
          const q = searchQuery.trim().toLowerCase();
          candidates.sort((a, b) => {
            const score = ({ title }) => {
              const t = title.toLowerCase();
              if (t === q) return 0;
              if (t.startsWith(q)) return 1;
              return 2;
            };
            return score(a) - score(b);
          });
        }
        setSearchResults(candidates.slice(0, 6));
      } catch (error) {
        if (error.name !== 'AbortError') {
          setSearchResults([]);
          if (baseType === 'location' && Platform.OS === 'android') {
            ToastAndroid.show('地点联想失败：' + (error.message || error), ToastAndroid.SHORT);
          }
        }
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 400);

    return () => {
      controller.abort();
      clearTimeout(delayDebounceFn);
    };
  }, [searchQuery, baseType, subType, tdtKey, searchFocused]);

  // 旅票出发地/目的地：天地图地名联想（isPrompt 的联想词无坐标，选中后拿它继续搜）
  useEffect(() => {
    if (baseType !== 'ticket') return;
    if (skipOriginSearch.current) { skipOriginSearch.current = false; return; }
    if (!originFocused) { setOriginResults([]); setShowOriginAuto(false); return; }
    if (!ticketOrigin.trim()) { setOriginResults([]); setShowOriginAuto(false); return; }
    const controller = new AbortController();
    const t = setTimeout(() => {
      fetchPlaceSuggestions(ticketOrigin, tdtKey, controller.signal)
        .then(results => { setOriginResults(results); setShowOriginAuto(true); })
        .catch(error => {
          if (error?.name !== 'AbortError' && Platform.OS === 'android') {
            ToastAndroid.show('出发地联想失败：' + (error.message || error), ToastAndroid.SHORT);
          }
        });
    }, 300);
    return () => { controller.abort(); clearTimeout(t); };
  }, [ticketOrigin, baseType, tdtKey, originFocused]);

  useEffect(() => {
    if (baseType !== 'ticket') return;
    if (skipDestSearch.current) { skipDestSearch.current = false; return; }
    if (!destFocused) { setDestResults([]); setShowDestAuto(false); return; }
    if (!ticketDest.trim()) { setDestResults([]); setShowDestAuto(false); return; }
    const controller = new AbortController();
    const t = setTimeout(() => {
      fetchPlaceSuggestions(ticketDest, tdtKey, controller.signal)
        .then(results => { setDestResults(results); setShowDestAuto(true); })
        .catch(error => {
          if (error?.name !== 'AbortError' && Platform.OS === 'android') {
            ToastAndroid.show('目的地联想失败：' + (error.message || error), ToastAndroid.SHORT);
          }
        });
    }, 300);
    return () => { controller.abort(); clearTimeout(t); };
  }, [ticketDest, baseType, tdtKey, destFocused]);

  // 联想选中：普通结果记住坐标并收起（跳过自动重搜）；联想词没有坐标，换词后继续搜
  const pickOrigin = (item) => {
    setTicketOrigin(item.name);
    setShowOriginAuto(false);
    setOriginCoord(!item.isPrompt && item.lng != null ? { lng: item.lng, lat: item.lat } : null);
    skipOriginSearch.current = !item.isPrompt;
  };
  const pickDest = (item) => {
    setTicketDest(item.name);
    setShowDestAuto(false);
    setDestCoord(!item.isPrompt && item.lng != null ? { lng: item.lng, lat: item.lat } : null);
    skipDestSearch.current = !item.isPrompt;
  };

  // 选择影像：应用内相册直读选图器（MediaPicker），只记录相册资产引用（assetId），全程零复制。
  // 用回调收结果 + goBack 返回，避免跨导航器跳转把本页草稿状态冲掉
  const openMediaPicker = () => {
    navigation.navigate('MediaPicker', {
      selected: selectedImages,
      onDone: (picked) => {
        const usedElsewhere = new Set();
        logData.forEach(log => {
          if (editId && log.id === editId) return;
          (log.localImages || []).forEach(e => { if (typeof e !== 'string' && e?.assetId) usedElsewhere.add(e.assetId); });
        });
        const existing = new Set(selectedImages.map(e => e?.assetId).filter(Boolean));
        const list = Array.isArray(picked) ? picked : [];
        const fresh = list.filter(p => p?.assetId && !existing.has(p.assetId) && !usedElsewhere.has(p.assetId));
        const skipped = list.length - fresh.length;
        if (skipped > 0 && Platform.OS === 'android') {
          ToastAndroid.show(`已跳过 ${skipped} 个重复添加的影像`, ToastAndroid.SHORT);
        }
        if (fresh.length > 0) {
          setSelectedImages(prev => [...prev, ...fresh]);
          capturePhotoCoord(fresh);
        }
      },
    });
  };

  // 从新选的照片里读第一张带 GPS 的位置，作为"地点"印记的坐标兜底（截图等无定位的照片会跳过）
  const capturePhotoCoord = async (fresh) => {
    try {
      for (const entry of fresh) {
        if (!entry?.assetId) continue;
        const info = await MediaLibrary.getAssetInfoAsync(entry.assetId);
        const loc = info?.location;
        if (loc && loc.latitude != null && loc.longitude != null) {
          setPhotoCoord({ longitude: loc.longitude, latitude: loc.latitude });
          if (Platform.OS === 'android') ToastAndroid.show('已从照片读取位置', ToastAndroid.SHORT);
          return;
        }
      }
    } catch {}
  };

  // 编辑页的返回键直接回主界面（与其余二级页一致的返回策略）
  useEffect(() => {
    if (route.name !== 'Edit') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      navigation.popToTop();
      return true;
    });
    return () => sub.remove();
  }, [route.name, navigation]);

  const handleStarPress = (s) => {
    if (rating === s - 0.5) setRating(s); 
    else if (rating === s) setRating(0); 
    else setRating(s - 0.5); 
  };

  // 出发地/目的地落库：联想选中的坐标优先，没选中则天地图地理编码兜底；名称始终保留
  const resolvePlace = async (name, coord) => {
    if (!name.trim()) return null;
    let lng = coord ? coord.lng : null, lat = coord ? coord.lat : null;
    if (lng == null && hasLocationSearch(tdtKey)) {
      const g = await fetchPlaceGeocode(name, tdtKey).catch(() => null);
      if (g) { lng = g.lng; lat = g.lat; }
    }
    return { name: name.trim(), longitude: lng, latitude: lat };
  };

  const handleSave = async () => {
    if (!year || !month || !day) {
      Alert.alert('提示', '请至少填写完整的年月日');
      return;
    }

    // 豆瓣/Steam/百科的海报下载到本地持久目录，列表封面离线也能显示
    const savedCoverUrl = baseType === 'media' && coverUrl ? await downloadRemoteCover(coverUrl) : null;

    // 只有存在本地副本（旧数据/系统选择器时代）才需要重链；
    // 应用内选图器产物是纯相册引用，保存零扫描零等待
    const hasCopies = selectedImages.some(e => isAppOwnedMediaPath(mediaUri(e)));
    if (hasCopies && Platform.OS === 'android') {
      ToastAndroid.show('正在关联相册影像…', ToastAndroid.LONG);
    }
    const relink = await relinkNewEntries(selectedImages);
    if (relink.keptCount > 0 && Platform.OS === 'android') {
      ToastAndroid.show(
        `${relink.keptCount} 个影像将以副本保存（${relink.reason || '未能关联到相册原片'}），可在"同步相册影像"中重试`,
        ToastAndroid.LONG
      );
    }

    // 旅票出发/到达：坐标来自联想选择，没选中则地理编码兜底（无 Key 时只存名称，地图上不标点）
    let start = null, end = null;
    if (baseType === 'ticket') {
      start = await resolvePlace(ticketOrigin, originCoord);
      end = await resolvePlace(ticketDest, destCoord);
    }

    // 地点坐标优先级：联想选中的 > 照片 GPS > 天地图地理编码兜底；都没有则不标点
    let coordinates = null;
    if (baseType === 'location') {
      let lng = locationCoords ? locationCoords.lng : null;
      let lat = locationCoords ? locationCoords.lat : null;
      if (lng == null && photoCoord) { lng = photoCoord.longitude; lat = photoCoord.latitude; }
      if (lng == null && hasLocationSearch(tdtKey)) {
        const g = await fetchPlaceGeocode(searchQuery, tdtKey).catch(() => null);
        if (g) { lng = g.lng; lat = g.lat; }
      }
      if (lng != null && lat != null) coordinates = { latitude: lat, longitude: lng };
    }

    const logDataToSave = {
      id: editId || Date.now(),
      baseType,
      subType,
      title: baseType === 'ticket' ? `${ticketOrigin} → ${ticketDest}` : searchQuery || '未命名记录',
      subtitle: baseType === 'ticket' ? ticketNo : comment,
      // 旅票的 subtitle 被车次/航班号占用，评论单独存字段，否则保存时会丢掉
      comment: baseType === 'ticket' && comment.trim() ? comment : null,
      // 时间选填：填了才拼进日期，不填只存日期（不再出现 00:00 凑数时间）
      date: `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`
        + ((hour || minute) ? ` ${(hour || '00').padStart(2,'0')}:${(minute || '00').padStart(2,'0')}` : ''),
      rating: rating > 0 ? rating : null,
      start,
      end,
      localImages: relink.entries,
      coverUrl: savedCoverUrl,
      coverRatio: savedCoverUrl ? coverRatio : null,
      coordinates,
    };

    if (editId) {
      updateLog(logDataToSave);
    } else {
      addLog(logDataToSave);
    }

    // 重链成功的条目已指向相册原片，选图器留在缓存里的临时拷贝直接删掉
    for (const uri of relink.replacedUris) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {}
    }

    clearForm();
    // 统一返回策略：二级页保存/取消都直接回主界面
    if (route.name === 'Edit') {
      navigation.popToTop();
    } else {
      navigation.navigate('Main', { screen: 'Home' });
    }
  };

  const renderRating = () => {
    return (
      <View style={styles.ratingSection}>
        <Text style={styles.inputLabel}>评分</Text>
        <View style={styles.starRow}>
          {[1, 2, 3, 4, 5].map((s) => {
            const isFull = s <= rating;
            const isHalf = s === Math.ceil(rating) && !Number.isInteger(rating);
            return (
              <TouchableOpacity key={s} onPress={() => handleStarPress(s)}>
                {isHalf ? <StarHalf size={32} color="#FACC15" fill="#FACC15" style={{ marginRight: 8 }} /> : <Star size={32} color={isFull ? "#FACC15" : "#E5E7EB"} fill={isFull ? "#FACC15" : "transparent"} style={{ marginRight: 8 }} />}
              </TouchableOpacity>
            );
          })}
          {rating > 0 && <Text style={styles.ratingScore}>{rating} 分</Text>}
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={[styles.container, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { clearForm(); if (route.name === 'Edit') { navigation.popToTop(); } else { navigation.navigate('Main', { screen: 'Home' }); } }}><Text style={styles.cancelText}>取消</Text></TouchableOpacity>
        <Text style={styles.headerTitle}>{editId ? '编辑印记' : '新印记'}</Text>
        <TouchableOpacity onPress={handleSave}><Text style={styles.saveText}>保存</Text></TouchableOpacity>
      </View>

      <ScrollView style={styles.formScroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.cardSection}>
          {/* 类型字段：点开底部弹层做二级选择（大类 → 子类） */}
          <TouchableOpacity
            style={styles.typeRow}
            onPress={() => { setSheetBase(baseType); typeSheetRef.current?.present(); }}
          >
            <Text style={styles.typeLabel}>类型</Text>
            <Text style={styles.typeValue}>{baseType === 'location' ? '地点' : `${BASE_LABEL[baseType]} · ${SUB_LABEL[subType]}`}</Text>
            <ChevronRight size={16} color="#C7CAD1" />
          </TouchableOpacity>
          {baseType === 'ticket' && (
            <View style={{ zIndex: 10 }}>
              <Text style={styles.inputLabel}>出发地</Text>
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  value={ticketOrigin}
                  onChangeText={setTicketOrigin}
                  onFocus={() => { setOriginFocused(true); if (ticketOrigin.trim()) setShowOriginAuto(true); }}
                  onBlur={() => { setOriginFocused(false); setTimeout(() => setShowOriginAuto(false), 200); }}
                />
              </View>
              {showOriginAuto && originResults.length > 0 && (
                <Reanimated.View entering={FadeIn.duration(150)} style={[styles.autoCompleteBox, { top: 75 }]}>
                  {originResults.map((result, idx) => (
                    <TouchableOpacity key={idx} style={styles.autoCompleteItem} onPress={() => pickOrigin(result)}>
                      <SuggestionRow
                        title={result.name}
                        meta={result.district}
                        textStyle={styles.autoCompleteText}
                        metaStyle={styles.autoCompleteMeta}
                        onPress={() => pickOrigin(result)}
                      />
                    </TouchableOpacity>
                  ))}
                </Reanimated.View>
              )}
              <Text style={[styles.inputLabel, { marginTop: 16 }]}>目的地</Text>
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  value={ticketDest}
                  onChangeText={setTicketDest}
                  onFocus={() => { setDestFocused(true); if (ticketDest.trim()) setShowDestAuto(true); }}
                  onBlur={() => { setDestFocused(false); setTimeout(() => setShowDestAuto(false), 200); }}
                />
              </View>
              {showDestAuto && destResults.length > 0 && (
                <Reanimated.View entering={FadeIn.duration(150)} style={[styles.autoCompleteBox, { top: 160 }]}>
                  {destResults.map((result, idx) => (
                    <TouchableOpacity key={idx} style={styles.autoCompleteItem} onPress={() => pickDest(result)}>
                      <SuggestionRow
                        title={result.name}
                        meta={result.district}
                        textStyle={styles.autoCompleteText}
                        metaStyle={styles.autoCompleteMeta}
                        onPress={() => pickDest(result)}
                      />
                    </TouchableOpacity>
                  ))}
                </Reanimated.View>
              )}
              {!hasLocationSearch(tdtKey) && (
                <Text style={styles.autoCompleteHint}>提示：在侧边栏「地图服务 Key」填入天地图 Key（免费）后，出发地/目的地才能联想定位</Text>
              )}
              <Text style={[styles.inputLabel, { marginTop: 16 }]}>{TICKET_NO_LABEL[subType] || '票号'}</Text>
              <View style={styles.inputWrapper}><TextInput style={styles.input} value={ticketNo} onChangeText={setTicketNo} /></View>
            </View>
          )}

          {baseType === 'location' && (
            <View style={{ zIndex: 10 }}>
              <Text style={styles.inputLabel}>地点名称</Text>
              <View style={styles.inputWrapper}>
                <MapPin size={18} color="#9CA3AF" style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.input}
                  value={searchQuery}
                  onChangeText={(t) => {
                    // 手改名称视为"别名"：坐标跟随选中的地点，改名不影响标点位置
                    setSearchQuery(t);
                    if (t.trim().length === 0) { setShowSearchAuto(false); setSearchResults([]); }
                  }}
                  onFocus={() => { setSearchFocused(true); if (searchQuery.trim().length > 0) setShowSearchAuto(true); }}
                  onBlur={() => { setSearchFocused(false); setTimeout(() => setShowSearchAuto(false), 200); }}
                  onSubmitEditing={() => setShowSearchAuto(false)}
                />
              </View>

              {!hasLocationSearch(tdtKey) && (
                <Text style={styles.autoCompleteHint}>提示：在侧边栏「地图服务 Key」填入天地图 Key（免费）后，可联想地点并自动定位</Text>
              )}

              {hasLocationSearch(tdtKey) && showSearchAuto && searchResults.length > 0 && (
                <Reanimated.View entering={FadeIn.duration(150)} style={[styles.autoCompleteBox, { top: 75 }]}>
                  {isSearching ? (
                    <View style={{ padding: 16, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color="#007AFF" />
                    </View>
                  ) : (
                    searchResults.map((result, idx) => (
                      <TouchableOpacity
                        key={idx}
                        style={styles.autoCompleteItem}
                        onPress={() => {
                          skipNextSearch.current = !result.isPrompt;
                          setSearchQuery(result.name);
                          setLocationCoords(!result.isPrompt && result.lng != null ? { lng: result.lng, lat: result.lat } : null);
                          if (!result.isPrompt) setShowSearchAuto(false);
                        }}
                      >
                        <SuggestionRow
                          title={result.name}
                          meta={result.district}
                          textStyle={styles.autoCompleteText}
                          metaStyle={styles.autoCompleteMeta}
                          onPress={() => {
                            skipNextSearch.current = !result.isPrompt;
                            setSearchQuery(result.name);
                            setLocationCoords(!result.isPrompt && result.lng != null ? { lng: result.lng, lat: result.lat } : null);
                            if (!result.isPrompt) setShowSearchAuto(false);
                          }}
                        />
                      </TouchableOpacity>
                    ))
                  )}
                </Reanimated.View>
              )}
            </View>
          )}

          {baseType === 'media' && (
            <View style={{ zIndex: 10 }}>
              <Text style={styles.inputLabel}>记录作品</Text>
              <View style={[styles.inputWrapper, { marginBottom: 0 }]}>
                <Search size={18} color="#9CA3AF" style={{ marginRight: 8 }} />
                <TextInput 
                  style={styles.input} 
                  value={searchQuery} 
                  returnKeyType="done"
                  onChangeText={(t) => {
                    setSearchQuery(t);
                    setCoverUrl(null); setCoverRatio(null); // 手动改动标题后，之前的网络封面不再匹配
                    if(t.trim().length === 0) { setShowSearchAuto(false); setSearchResults([]); }
                  }}
                  onFocus={() => { setSearchFocused(true); if(searchQuery.trim().length > 0) setShowSearchAuto(true); }}
                  onBlur={() => { setSearchFocused(false); setTimeout(() => setShowSearchAuto(false), 200); }}
                  onSubmitEditing={() => setShowSearchAuto(false)}
                />
              </View>

              {showSearchAuto && searchResults.length > 0 && (
                <Reanimated.View entering={FadeIn.duration(150)} style={[styles.autoCompleteBox, { top: 75 }]}>

                  {isSearching ? (
                    <View style={{ padding: 16, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color="#007AFF" />
                    </View>
                  ) : (
                    searchResults.map((result, idx) => (
                      <TouchableOpacity
                        key={idx}
                        style={styles.autoCompleteItem}
                        onPress={() => {
                          skipNextSearch.current = true;
                          setSearchQuery(result.title);
                          setCoverUrl(result.artwork); setCoverRatio(result.ratio || null);
                          setShowSearchAuto(false);
                        }}
                      >
                        {/* 长词条可横向拖动查看完整内容 */}
                        <SuggestionRow
                          title={result.title}
                          meta={result.meta}
                          textStyle={styles.autoCompleteText}
                          metaStyle={styles.autoCompleteMeta}
                          onPress={() => {
                            skipNextSearch.current = true;
                            setSearchQuery(result.title);
                            setCoverUrl(result.artwork); setCoverRatio(result.ratio || null);
                            setShowSearchAuto(false);
                          }}
                        />
                      </TouchableOpacity>
                    ))
                  )}
                </Reanimated.View>
              )}
            </View>
          )}

          <View style={styles.divider} />

          <View>
            <Text style={styles.inputLabel}>发生日期</Text>
            <View style={styles.dateRow}>
              <TextInput style={[styles.dateBox, styles.dateBoxYear]} keyboardType="number-pad" maxLength={4} value={year} onChangeText={setYear} />
              <Text style={styles.dateLabelText}>年</Text>
              <TextInput style={styles.dateBox} keyboardType="number-pad" maxLength={2} value={month} onChangeText={setMonth} />
              <Text style={styles.dateLabelText}>月</Text>
              <TextInput style={styles.dateBox} keyboardType="number-pad" maxLength={2} value={day} onChangeText={setDay} />
              <Text style={styles.dateLabelText}>日</Text>
            </View>

            <View style={{ marginTop: 12 }}>
              <Text style={styles.inputLabel}>具体时间（选填）</Text>
              <View style={styles.dateRow}>
                <TextInput style={styles.dateBox} keyboardType="number-pad" maxLength={2} value={hour} onChangeText={setHour} />
                <Text style={styles.dateLabelText}>时</Text>
                <TextInput style={styles.dateBox} keyboardType="number-pad" maxLength={2} value={minute} onChangeText={setMinute} />
                <Text style={styles.dateLabelText}>分</Text>
              </View>
            </View>
          </View>

          <View style={styles.divider} />
          {renderRating()}
          <View style={[styles.divider, { marginVertical: 12 }]} />

          <View>
            <Text style={styles.inputLabel}>评论</Text>
            <TextInput style={styles.commentInput} multiline numberOfLines={4} textAlignVertical="top" value={comment} onChangeText={setComment} />
          </View>

          <View style={styles.divider} />

          <View>
            <Text style={styles.inputLabel}>{baseType === 'ticket' ? '票根 / 留影' : '现场影像 / 截图'} ({selectedImages.length})</Text>
            <View style={styles.imageGrid}>
              {selectedImages.map((entry, idx) => (
                <View key={idx} style={styles.imageGridItem}>
                  {isVideoEntry(entry) ? (
                    <VideoPreview entry={entry} />
                  ) : (
                    <Image source={{ uri: mediaUri(entry) }} style={styles.imageGridImage} />
                  )}
                  <TouchableOpacity style={styles.removeImageBtn} onPress={() => { const n = [...selectedImages]; n.splice(idx,1); setSelectedImages(n); }}>
                    <X size={12} color="#FFF" />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={styles.imageGridItem}>
                <TouchableOpacity style={styles.addImageBtn} onPress={openMediaPicker}>
                  <ImagePlus size={24} color="#9CA3AF" />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* 二级类型选择：第一级大类卡片，第二级子类 chips；地点无子类直接选中 */}
      <BottomSheetModal
        ref={typeSheetRef}
        backdropComponent={renderTypeBackdrop}
        handleIndicatorStyle={{ backgroundColor: '#D1D5DB' }}
      >
        <BottomSheetView style={styles.sheetContent}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>选择类型</Text>
            <TouchableOpacity onPress={() => typeSheetRef.current?.dismiss()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <X size={20} color="#9CA3AF" />
            </TouchableOpacity>
          </View>

          <View style={styles.catRow}>
            {[
              { id: 'ticket', label: '旅票', Icon: Plane, color: '#007AFF', bg: '#E0F2FE' },
              { id: 'location', label: '地点', Icon: MapPin, color: '#EF4444', bg: '#FEE2E2' },
              { id: 'media', label: '娱乐', Icon: Film, color: '#A855F7', bg: '#F3E8FF' },
            ].map(cat => (
              <TouchableOpacity
                key={cat.id}
                style={[styles.catCard, sheetBase === cat.id && styles.catCardActive]}
                onPress={() => {
                  if (cat.id === 'location') {
                    applyType('location', 'location');
                    typeSheetRef.current?.dismiss();
                    return;
                  }
                  setSheetBase(cat.id);
                }}
              >
                <View style={[styles.catIconBox, { backgroundColor: cat.bg }]}><cat.Icon size={20} color={cat.color} /></View>
                <Text style={[styles.catLabel, sheetBase === cat.id && styles.catLabelActive]}>{cat.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {sheetBase === 'location' ? (
            <Text style={styles.lv2Hint}>地点不分子类，点上方卡片即可选中</Text>
          ) : (
            <View style={styles.chipWrap}>
              {SUB_OPTIONS[sheetBase].map(opt => {
                const active = sheetBase === baseType && subType === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => { applyType(sheetBase, opt.id); typeSheetRef.current?.dismiss(); }}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </BottomSheetView>
      </BottomSheetModal>

    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#FFF' },
  cancelText: { fontSize: 16, color: '#6B7280' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#1C1C1E' },
  saveText: { fontSize: 16, fontWeight: '600', color: '#007AFF' },
  formScroll: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  typeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, paddingHorizontal: 12, height: 46, marginBottom: 16 },
  typeLabel: { fontSize: 15, color: '#9CA3AF', marginRight: 8 },
  typeValue: { flex: 1, fontSize: 15, fontWeight: '600', color: '#1C1C1E' },
  sheetContent: { paddingHorizontal: 16, paddingBottom: 24 },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  sheetTitle: { fontSize: 17, fontWeight: '600', color: '#1C1C1E' },
  catRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  catCard: { flex: 1, borderWidth: 1.5, borderColor: '#E5E7EB', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  catCardActive: { borderColor: '#007AFF', backgroundColor: '#F0F8FF' },
  catIconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  catLabel: { fontSize: 14, fontWeight: '500', color: '#6B7280' },
  catLabelActive: { color: '#007AFF', fontWeight: '600' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { paddingVertical: 9, paddingHorizontal: 18, backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: '#F3F4F6', borderRadius: 19 },
  chipActive: { backgroundColor: '#E0F2FE', borderColor: '#BAE6FD' },
  chipText: { fontSize: 14, color: '#4B5563' },
  chipTextActive: { color: '#007AFF', fontWeight: '500' },
  lv2Hint: { fontSize: 13, color: '#9CA3AF', paddingVertical: 10 },
  cardSection: { backgroundColor: '#FFF', borderRadius: 14, padding: 16, marginBottom: 40 },
  inputLabel: { fontSize: 13, fontWeight: '500', color: '#9CA3AF', marginBottom: 8 },
  inputWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, paddingHorizontal: 12, height: 44, marginBottom: 16 },
  input: { flex: 1, fontSize: 15, color: '#1C1C1E' },
  autoCompleteBox: { position: 'absolute', top: 70, left: 0, right: 0, backgroundColor: '#FFF', borderRadius: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4, zIndex: 99, overflow: 'hidden' },
  autoCompleteItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  autoCompleteThumb: { width: 36, height: 36, borderRadius: 6 },
  autoCompleteText: { fontSize: 15, color: '#1C1C1E' },
  autoCompleteMeta: { fontSize: 12, color: '#8E8E93', marginTop: 1 },
  autoCompleteHint: { fontSize: 12, color: '#9CA3AF', marginTop: 8 },
  divider: { height: 1, backgroundColor: '#F3F4F6', marginVertical: 16 },
  dateRow: { flexDirection: 'row', alignItems: 'center' },
  dateBox: { backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, height: 42, width: 48, textAlign: 'center', fontSize: 16, fontWeight: '600', color: '#1C1C1E' },
  dateBoxYear: { width: 64 }, 
  dateLabelText: { fontSize: 14, color: '#6B7280', marginHorizontal: 6, fontWeight: '500' },
  ratingSection: { marginBottom: 8 },
  starRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  ratingScore: { fontSize: 18, fontWeight: 'bold', color: '#FACC15', marginLeft: 12 },
  commentInput: { backgroundColor: '#F9FAFB', borderRadius: 10, padding: 12, fontSize: 15, height: 100, color: '#1C1C1E', borderWidth: 1, borderColor: '#E5E7EB' },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginTop: 4 },
  imageGridItem: { width: '33.33%', padding: 4 },
  imageGridImage: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: '#E5E5EA', overflow: 'hidden' },
  playOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  addImageBtn: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: '#E5E7EB', borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center' },
  removeImageBtn: { position: 'absolute', top: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', width: 20, height: 20, borderRadius: 10, justifyContent: 'center', alignItems: 'center' }
});