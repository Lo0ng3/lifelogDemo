import React, { useState, useEffect, useContext, useRef } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, KeyboardAvoidingView, Platform, Image, Alert, ActivityIndicator,
  BackHandler, ToastAndroid
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Plane, Train, Bus, Ship, MapPin, Film, Tv, Ghost, Gamepad2, Book,
  Search, ImagePlus, X, Star, StarHalf, Check, PlayCircle
} from 'lucide-react-native';
import { mediaUri, normalizeMediaEntry, resolveMediaUri, downloadRemoteCover, getVideoThumbnail, isAppOwnedMediaPath, isVideoEntry } from '../utils/media';
import { relinkNewEntries } from '../utils/mediaSync';
import Reanimated, { FadeIn } from 'react-native-reanimated';
import { LogContext } from '../context/LogContext';
import { fetchSuggestions, fetchLocationSuggestions, hasLocationSearch } from '../utils/search';

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
  const { logData, addLog, updateLog } = useContext(LogContext);
  
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
  const [locationCoords, setLocationCoords] = useState(null); // 地点联想命中的 "lng,lat"

  const skipNextSearch = useRef(false);

  const clearForm = () => {
    setEditId(null);
    setRating(0); setComment(''); setTicketOrigin(''); setTicketDest(''); setTicketNo('');
    setYear(''); setMonth(''); setDay(''); setHour(''); setMinute('');
    setSelectedImages([]); setSearchQuery(''); setShowSearchAuto(false);
    setSearchResults([]); setCoverUrl(null); setCoverRatio(null); setLocationCoords(null);
  };

  // 手动切换大类：切默认子类型并完全重置表单（不能用 effect 监听 baseType 来做，
  // 否则编辑预填改 baseType 时会把刚填入的记录内容清掉）
  const handleBaseTypeChange = (type) => {
    if (type === baseType) return;
    setBaseType(type);
    setSubType(type === 'ticket' ? 'flight' : (type === 'location' ? 'location' : 'movie'));
    clearForm();
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
      setComment(item.baseType !== 'ticket' ? item.subtitle || '' : '');
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
      } else {
        skipNextSearch.current = true;
        setSearchQuery(item.title || '');
      }
      if (item.baseType === 'location' && item.coordinates) {
        setLocationCoords(`${item.coordinates.longitude},${item.coordinates.latitude}`);
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
          candidates = await fetchLocationSuggestions(searchQuery.trim(), controller.signal);
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
        if (error.name !== 'AbortError') setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 400);

    return () => {
      controller.abort();
      clearTimeout(delayDebounceFn);
    };
  }, [searchQuery, baseType, subType]);

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
        if (fresh.length > 0) setSelectedImages(prev => [...prev, ...fresh]);
      },
    });
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

    // 地点：联想选中的用真实坐标，手填的退回随机坐标兜底
    let coordinates = null;
    if (baseType === 'location') {
      if (locationCoords) {
        const [lng, lat] = locationCoords.split(',').map(Number);
        coordinates = { latitude: lat, longitude: lng };
      } else {
        coordinates = { latitude: 39.90 + Math.random() * 0.1, longitude: 116.40 + Math.random() * 0.1 };
      }
    }

    const logDataToSave = {
      id: editId || Date.now(),
      baseType,
      subType,
      title: baseType === 'ticket' ? `${ticketOrigin} → ${ticketDest}` : searchQuery || '未命名记录',
      subtitle: baseType === 'ticket' ? ticketNo : comment,
      date: baseType === 'ticket'
        ? `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')} ${hour ? hour.padStart(2,'0') : '00'}:${minute ? minute.padStart(2,'0') : '00'}`
        : `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`,
      rating: rating > 0 ? rating : null,
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
    if (baseType === 'ticket') return null;
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

  const renderSubTypes = () => {
    let options = [];
    if (baseType === 'ticket') {
      options = [
        { id: 'flight', label: '机票', Icon: Plane }, { id: 'train', label: '火车票', Icon: Train },
        { id: 'bus', label: '汽车票', Icon: Bus }, { id: 'ship', label: '轮船', Icon: Ship }
      ];
    } else if (baseType === 'media') {
      options = [
        { id: 'movie', label: '电影', Icon: Film }, { id: 'tv', label: '剧集', Icon: Tv },
        { id: 'anime', label: '动漫', Icon: Ghost }, { id: 'game', label: '游戏', Icon: Gamepad2 },
        { id: 'book', label: '书籍', Icon: Book }
      ];
    } else { return null; }

    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.subTypeContainer}>
        {options.map(opt => (
          <TouchableOpacity key={opt.id} style={[styles.subTypeChip, subType === opt.id && styles.subTypeChipActive]} onPress={() => { setSubType(opt.id); clearForm(); }}>
            <opt.Icon size={16} color={subType === opt.id ? '#007AFF' : '#6B7280'} />
            <Text style={[styles.subTypeChipText, subType === opt.id && styles.subTypeChipTextActive]}>{opt.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
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
        <View style={styles.segmentedControl}>
          {[{ id: 'ticket', label: '旅票' }, { id: 'location', label: '地点' }, { id: 'media', label: '娱乐' }].map(t => (
            <TouchableOpacity key={t.id} style={[styles.segmentBtn, baseType === t.id && styles.segmentBtnActive]} onPress={() => handleBaseTypeChange(t.id)}>
              <Text style={[styles.segmentText, baseType === t.id && styles.segmentTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {renderSubTypes()}

        <View style={styles.cardSection}>
          {baseType === 'ticket' && (
            <View style={{ zIndex: 10 }}>
              <Text style={styles.inputLabel}>出发地</Text>
              <View style={styles.inputWrapper}><TextInput style={styles.input} value={ticketOrigin} onChangeText={setTicketOrigin} /></View>
              <Text style={[styles.inputLabel, { marginTop: 16 }]}>目的地</Text>
              <View style={styles.inputWrapper}><TextInput style={styles.input} value={ticketDest} onChangeText={setTicketDest} /></View>
              <Text style={[styles.inputLabel, { marginTop: 16 }]}>{subType === 'flight' ? '航班号' : subType === 'train' ? '车次' : '班次'}</Text>
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
                    setSearchQuery(t);
                    setLocationCoords(null); // 手动改名后，之前的联想坐标不再匹配
                    if (t.trim().length === 0) { setShowSearchAuto(false); setSearchResults([]); }
                  }}
                  onFocus={() => { if (searchQuery.trim().length > 0) setShowSearchAuto(true); }}
                  onBlur={() => setTimeout(() => setShowSearchAuto(false), 200)}
                  onSubmitEditing={() => setShowSearchAuto(false)}
                />
              </View>

              {!hasLocationSearch() && (
                <Text style={styles.autoCompleteHint}>提示：在 src/utils/search.js 填入免费的高德 Key 后，可联想地点并自动定位</Text>
              )}

              {hasLocationSearch() && showSearchAuto && searchResults.length > 0 && (
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
                          setLocationCoords(result.location || null);
                          setShowSearchAuto(false);
                        }}
                      >
                        <SuggestionRow
                          title={result.title}
                          meta={result.meta}
                          textStyle={styles.autoCompleteText}
                          metaStyle={styles.autoCompleteMeta}
                          onPress={() => {
                            skipNextSearch.current = true;
                            setSearchQuery(result.title);
                            setLocationCoords(result.location || null);
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
                  onFocus={() => { if(searchQuery.trim().length > 0) setShowSearchAuto(true); }}
                  onBlur={() => setTimeout(() => setShowSearchAuto(false), 200)}
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

            {baseType === 'ticket' && (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.inputLabel}>具体时间</Text>
                <View style={styles.dateRow}>
                  <TextInput style={styles.dateBox} keyboardType="number-pad" maxLength={2} value={hour} onChangeText={setHour} />
                  <Text style={styles.dateLabelText}>时</Text>
                  <TextInput style={styles.dateBox} keyboardType="number-pad" maxLength={2} value={minute} onChangeText={setMinute} />
                  <Text style={styles.dateLabelText}>分</Text>
                </View>
              </View>
            )}
          </View>

          <View style={styles.divider} />
          {renderRating()}
          {baseType !== 'ticket' && <View style={[styles.divider, { marginVertical: 12 }]} />}

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
  segmentedControl: { flexDirection: 'row', backgroundColor: '#E5E5EA', borderRadius: 8, padding: 2, marginBottom: 16 },
  segmentBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
  segmentBtnActive: { backgroundColor: '#FFF', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1 },
  segmentText: { fontSize: 14, color: '#8E8E93', fontWeight: '500' },
  segmentTextActive: { color: '#1C1C1E' },
  subTypeContainer: { flexDirection: 'row', marginBottom: 16 },
  subTypeChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#E5E7EB', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginRight: 10 },
  subTypeChipActive: { backgroundColor: '#E0F2FE' },
  subTypeChipText: { marginLeft: 6, fontSize: 14, color: '#6B7280', fontWeight: '500' },
  subTypeChipTextActive: { color: '#007AFF' },
  cardSection: { backgroundColor: '#FFF', borderRadius: 14, padding: 16, marginBottom: 40 },
  inputLabel: { fontSize: 13, fontWeight: '500', color: '#9CA3AF', marginBottom: 8 },
  inputWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, paddingHorizontal: 12, height: 44, marginBottom: 16 },
  input: { flex: 1, fontSize: 15, color: '#1C1C1E' },
  autoCompleteBox: { position: 'absolute', top: 70, left: 0, right: 0, backgroundColor: '#FFF', borderRadius: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4, zIndex: 99, overflow: 'hidden' },
  autoCompleteItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  autoCompleteScroll: { flex: 1 },
  autoCompleteContent: { alignItems: 'center', paddingVertical: 2 },
  autoCompleteThumb: { width: 36, height: 36, borderRadius: 6 },
  autoCompleteText: { fontSize: 15, color: '#1C1C1E' },
  autoCompleteMeta: { fontSize: 12, color: '#8E8E93', marginTop: 1 },
  autoCompleteHint: { fontSize: 12, color: '#9CA3AF', marginTop: 8 },
  coverPreviewRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, backgroundColor: '#F9FAFB', borderRadius: 10, padding: 8, gap: 8 },
  coverPreviewThumb: { width: 40, height: 40, borderRadius: 6 },
  coverPreviewText: { flex: 1, fontSize: 12, color: '#6B7280' },
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