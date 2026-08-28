import React, { useState, useEffect, useContext, useRef } from 'react';
import { 
  View, Text, StyleSheet, TextInput, TouchableOpacity, 
  ScrollView, KeyboardAvoidingView, Platform, Image, Alert, ActivityIndicator
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { 
  Plane, Train, Bus, Ship, MapPin, Film, Tv, Ghost, Gamepad2, Book, 
  Search, ImagePlus, X, Star, StarHalf, Check 
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Image as ExpoImage } from 'expo-image';

import { LogContext } from '../context/LogContext';
import { getIconConfig } from '../utils/icons';
import { mediaUri, normalizeMediaEntry, resolveMediaUri, downloadRemoteCover } from '../utils/media';
import { fetchSuggestions, fetchLocationSuggestions, hasLocationSearch } from '../utils/search';

export default function AddScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { addLog, updateLog } = useContext(LogContext); 
  
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
  const [locationCoords, setLocationCoords] = useState(null); // 地点联想命中的 "lng,lat"

  const skipNextSearch = useRef(false);

  const clearForm = () => {
    setEditId(null);
    setRating(0); setComment(''); setTicketOrigin(''); setTicketDest(''); setTicketNo('');
    setYear(''); setMonth(''); setDay(''); setHour(''); setMinute('');
    setSelectedImages([]); setSearchQuery(''); setShowSearchAuto(false);
    setSearchResults([]); setCoverUrl(null); setLocationCoords(null);
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

  const pickImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsEditing: false,
      allowsMultipleSelection: true,
      quality: 1, // 不压缩，只留引用；真实文件仍在相册里
    });
    if (!result.canceled && result.assets) {
      // 只记录相册资产的引用（assetId），uri 仅作备用；不再复制文件进 App
      setSelectedImages([
        ...selectedImages,
        ...result.assets.map(a => ({ uri: a.uri, assetId: a.assetId || null, isVideo: a.type === 'video' })),
      ]);
    }
  };

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

    // 豆瓣海报下载到本地持久目录，列表封面离线也能显示
    const savedCoverUrl = baseType === 'media' && coverUrl ? await downloadRemoteCover(coverUrl) : null;

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
      localImages: selectedImages,
      coverUrl: savedCoverUrl,
      coordinates,
    };

    if (editId) {
      updateLog(logDataToSave);
      setEditId(null);
    } else {
      addLog(logDataToSave);
    }

    cleanupTempCopies(logDataToSave.localImages);

    clearForm();
    // 返回首页列表（Add 在 Tab 里，从二级页面进入时不能直接 goBack）
    navigation.navigate('Main', { screen: 'Home' });
  };

  // 只存相册引用：记录里已保存 assetId 的条目，把选择时系统复制进 App 缓存的临时文件删掉，
  // 显示时通过 assetId 从相册解析原件，不依赖这份拷贝
  const cleanupTempCopies = (entries) => {
    entries.forEach(async (entry) => {
      if (entry?.assetId && entry.uri?.startsWith('file:')) {
        try {
          await FileSystem.deleteAsync(entry.uri, { idempotent: true });
        } catch {
          // 删除失败不影响保存，系统之后也会清理缓存
        }
      }
    });
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
        <TouchableOpacity onPress={() => { clearForm(); setEditId(null); navigation.navigate('Main', { screen: 'Home' }); }}><Text style={styles.cancelText}>取消</Text></TouchableOpacity>
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
                <View style={[styles.autoCompleteBox, { top: 75 }]}>
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
                        <View style={[styles.autoCompleteThumb, { backgroundColor: '#FEE2E2', alignItems: 'center', justifyContent: 'center' }]}>
                          <MapPin size={14} color="#EF4444" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.autoCompleteText} numberOfLines={1}>{result.title}</Text>
                          {!!result.meta && <Text style={styles.autoCompleteMeta} numberOfLines={1}>{result.meta}</Text>}
                        </View>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
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
                    setCoverUrl(null); // 手动改动标题后，之前的网络封面不再匹配
                    if(t.trim().length === 0) { setShowSearchAuto(false); setSearchResults([]); }
                  }}
                  onFocus={() => { if(searchQuery.trim().length > 0) setShowSearchAuto(true); }}
                  onBlur={() => setTimeout(() => setShowSearchAuto(false), 200)}
                  onSubmitEditing={() => setShowSearchAuto(false)}
                />
              </View>

              {baseType === 'media' && subType === 'game' && (
                <Text style={styles.autoCompleteHint}>游戏暂不支持网络检索，直接输入名称即可</Text>
              )}

              {coverUrl && (
                <View style={styles.coverPreviewRow}>
                  <ExpoImage source={{ uri: coverUrl }} style={styles.coverPreviewThumb} contentFit="cover" />
                  <Text style={styles.coverPreviewText}>已获取网络封面，保存后会在列表中显示</Text>
                  <TouchableOpacity onPress={() => setCoverUrl(null)}><X size={16} color="#9CA3AF" /></TouchableOpacity>
                </View>
              )}

              {showSearchAuto && searchResults.length > 0 && (
                <View style={[styles.autoCompleteBox, { top: 75 }]}>
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
                          setCoverUrl(result.artwork);
                          setShowSearchAuto(false);
                        }}
                      >
                        {result.artwork ? (
                          <ExpoImage source={{ uri: result.artwork }} style={styles.autoCompleteThumb} contentFit="cover" transition={100} />
                        ) : (
                          <View style={[styles.autoCompleteThumb, { backgroundColor: '#F3E8FF', alignItems: 'center', justifyContent: 'center' }]}>
                            {(() => { const { IconComponent, iconColor } = getIconConfig({ baseType: 'media', subType }); return <IconComponent size={14} color={iconColor} />; })()}
                          </View>
                        )}
                        <View style={{ flex: 1 }}>
                          <Text style={styles.autoCompleteText} numberOfLines={1}>{result.title}</Text>
                          {!!result.meta && <Text style={styles.autoCompleteMeta} numberOfLines={1}>{result.meta}</Text>}
                        </View>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
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
                  <Image source={{ uri: mediaUri(entry) }} style={styles.imageGridImage} />
                  <TouchableOpacity style={styles.removeImageBtn} onPress={() => { const n = [...selectedImages]; n.splice(idx,1); setSelectedImages(n); }}>
                    <X size={12} color="#FFF" />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={styles.imageGridItem}>
                <TouchableOpacity style={styles.addImageBtn} onPress={pickImage}>
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
  autoCompleteItem: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#F3F4F6', gap: 8 },
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
  imageGridImage: { width: '100%', aspectRatio: 1, borderRadius: 10 },
  addImageBtn: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: '#E5E7EB', borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center' },
  removeImageBtn: { position: 'absolute', top: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', width: 20, height: 20, borderRadius: 10, justifyContent: 'center', alignItems: 'center' }
});