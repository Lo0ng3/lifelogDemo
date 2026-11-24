import React, { useState, useEffect, useContext, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  BackHandler, ToastAndroid, Modal, Keyboard
} from 'react-native';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Plane, MapPin, Film, NotebookPen, Search, ImagePlus, X, Check, Star, StarHalf, ChevronRight, ChevronDown, PlayCircle, Maximize2
} from 'lucide-react-native';
import NativeIcon from '../components/NativeIcon';
import { hapticSelection, hapticSuccess } from '../utils/haptics';
import { mediaUri, normalizeMediaEntry, resolveMediaUri, downloadRemoteCoverVariants, getVideoThumbnail, isAppOwnedMediaPath, isVideoEntry, setDraftMediaEntries } from '../utils/media';
import { relinkNewEntries } from '../utils/mediaSync';
import { deletePathAsync } from '../utils/storagePaths';
import { onAddDraftReset } from '../utils/draftReset';
import Reanimated, { FadeIn } from 'react-native-reanimated';
import { LogContext } from '../context/LogContext';
import { fetchSuggestions, fetchPlaceSuggestions, fetchPlaceGeocode, hasLocationSearch, withTimeout } from '../utils/search';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { MOOD_OPTIONS, WEATHER_OPTIONS, NOTE_SUB_OPTIONS, TICKET_SUB_OPTIONS, MEDIA_SUB_OPTIONS } from '../utils/recordMeta';

// 二级类型选择：第一级大类 → 第二级子类；地点无子类
const BASE_LABEL = { ticket: '旅票', location: '地点', media: '娱乐', note: '随笔' };
const TYPE_MENU = [
  { id: 'ticket', label: '旅票', Icon: Plane, sfName: 'airplane' },
  { id: 'location', label: '地点', Icon: MapPin, sfName: 'mappin.and.ellipse' },
  { id: 'media', label: '娱乐', Icon: Film, sfName: 'film' },
  { id: 'note', label: '随笔', Icon: NotebookPen, sfName: 'square.and.pencil' },
];
const todayParts = () => {
  const d = new Date();
  return {
    y: String(d.getFullYear()),
    m: String(d.getMonth() + 1).padStart(2, '0'),
    d: String(d.getDate()).padStart(2, '0'),
  };
};
const SUB_OPTIONS = {
  ticket: TICKET_SUB_OPTIONS,
  media: MEDIA_SUB_OPTIONS,
  note: NOTE_SUB_OPTIONS,
};
const SUB_LABEL = {
  flight: '机票', train: '火车票', bus: '汽车票', ship: '轮船',
  movie: '电影', tv: '剧集', anime: '动漫', game: '游戏', book: '书籍',
  diary: '日记', memo: '事迹',
};
const TICKET_NO_LABEL = { flight: '航班号', train: '车次', bus: '班次', ship: '班次' };

// 比对「相关记录」用的归一化：忽略空格、全半角标点与大小写
const normKey = (s) => String(s || '')
  .replace(/\s+/g, '')
  .replace(/[（）()·・,，.。:：;；\-—_/|、]/g, '')
  .toLowerCase();

// 媒体条目的"身份"：有相册引用就用 assetId，没有（分享进来的副本、旧数据副本）
// 就用 文件名 + 大小 认人——只按 assetId 去重会让没有 assetId 的条目无限重复添加
const mediaKey = (raw) => {
  const e = normalizeMediaEntry(raw) || {};
  if (e.assetId) return `a:${e.assetId}`;
  const name = String(e.filename || e.uri || '').split('/').pop().toLowerCase();
  if (!name) return null;
  return `f:${name}${e.size ? ':' + e.size : ''}`;
};

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
  const styles = useThemedStyles(makeStyles);
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
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { logData, addLog, updateLog, tdtKey, mapProvider, amapKey } = useContext(LogContext);
  // 地点联想 / 地理编码用当前地图服务商的 key（天地图 tk / 高德 Web 服务 key）
  const loc = useMemo(
    () => ({ provider: mapProvider, key: mapProvider === 'amap' ? amapKey : tdtKey }),
    [mapProvider, tdtKey, amapKey]
  );
  
  const [editId, setEditId] = useState(null); 
  const [baseType, setBaseType] = useState('ticket'); 
  const [subType, setSubType] = useState('flight');
  
  const [rating, setRating] = useState(0); 
  const [comment, setComment] = useState(''); 
  // 随笔（一级）专用：标题选填、心情必填、日记多一个天气
  const [noteTitle, setNoteTitle] = useState('');
  const [mood, setMood] = useState(null);
  const [weather, setWeather] = useState(null);
  const [moodDraft, setMoodDraft] = useState('');
  const [editCoverIndex, setEditCoverIndex] = useState(null);   // 编辑时原封带回顾有的封面选择
  const [editPhotoCount, setEditPhotoCount] = useState(0);
  const [fullscreenComment, setFullscreenComment] = useState(false);  // 评论/内容全屏编辑
  const [ticketOrigin, setTicketOrigin] = useState('');
  const [ticketDest, setTicketDest] = useState('');
  const [ticketNo, setTicketNo] = useState(''); 
  const [year, setYear] = useState(() => (Platform.OS === 'ios' ? todayParts().y : ''));
  const [month, setMonth] = useState(() => (Platform.OS === 'ios' ? todayParts().m : ''));
  const [day, setDay] = useState(() => (Platform.OS === 'ios' ? todayParts().d : ''));
  const [hour, setHour] = useState('');
  const [minute, setMinute] = useState('');
  const [selectedImages, setSelectedImages] = useState([]);

  // 系统分享进来的影像（图库 → 分享 → 印记）：直接挂到当前表单上，
  // 类型/日期这些还是由用户自己填；同一批影像重复分享也能再次触发（shareToken 变）
  const sharedMedia = route?.params?.sharedMedia;
  const shareToken = route?.params?.shareToken;
  useEffect(() => {
    if (!Array.isArray(sharedMedia) || sharedMedia.length === 0) return;
    let added = 0;
    setSelectedImages((prev) => {
      // 同一批分享（或表单里已经有这张）不重复添加
      const have = new Set(prev.map(mediaKey).filter(Boolean));
      const fresh = [];
      for (const m of sharedMedia) {
        const k = mediaKey(m);
        if (!k || have.has(k)) continue;
        have.add(k);
        fresh.push(m);
      }
      added = fresh.length;
      return fresh.length ? [...prev, ...fresh] : prev;
    });
    setShowSearchAuto(false);
    if (Platform.OS === 'android') {
      ToastAndroid.show(
        added > 0 ? `已加入 ${added} 张分享进来的照片` : '这些照片已经在表单里了',
        ToastAndroid.SHORT
      );
    }
    navigation.setParams({ sharedMedia: null, shareToken: undefined });
  }, [sharedMedia, shareToken, navigation]);
  
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

  // 类型选择改成表单顶部的内联面板：大类 → 子类都在上方展开，不再从底部弹
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [sheetBase, setSheetBase] = useState('ticket');

  const clearForm = () => {
    const def = Platform.OS === 'ios' ? todayParts() : { y: '', m: '', d: '' };
    setEditId(null);
    setRating(0); setComment(''); setTicketOrigin(''); setTicketDest(''); setTicketNo('');
    setYear(def.y); setMonth(def.m); setDay(def.d); setHour(''); setMinute('');
    setSelectedImages([]); setSearchQuery(''); setShowSearchAuto(false);
    setNoteTitle(''); setMood(null); setWeather(null); setMoodDraft('');
    setEditCoverIndex(null); setEditPhotoCount(0);
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

  const chooseCategory = (id) => {
    setSheetBase(id);
    if (id === 'location') {
      applyType('location', 'location');
      setTypeMenuOpen(false);
      return;
    }
    const defaultSub = id === 'ticket' ? 'flight' : id === 'media' ? 'movie' : 'diary';
    if (id !== baseType || subType !== defaultSub) applyType(id, defaultSub);
  };

  const openRelatedRecord = (item) => {
    if (typeof navigation.push === 'function') navigation.push('Detail', { item });
    else {
      const parent = navigation.getParent?.();
      if (parent?.push) parent.push('Detail', { item });
      else navigation.navigate('Detail', { item });
    }
  };

  /* ---------------- 表单键盘体验 ----------------
     ① 回车 / 键盘上的「下一项」跳到下一个字段（日期格填满也自动跳）；
     ② 聚焦的输入框如果被输入法挡住，把它滚到键盘上方。
     两点都靠「字段 key 表 + 一份滚动容器 ref」实现，字段顺序随类型变化。 */
  const formScrollRef = useRef(null);
  const formScrollY = useRef(0);         // 滚动容器当前偏移
  const keyboardTopY = useRef(null);     // 键盘顶边的屏幕 Y（null = 键盘收起）
  const focusedField = useRef(null);     // 当前聚焦的字段 key
  const fieldNodes = useRef({});         // key -> TextInput 实例
  const fieldSetters = useRef({});       // key -> 稳定的 ref 回调（避免每次渲染重挂 ref）
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const fieldRef = (key) => {
    if (!fieldSetters.current[key]) {
      fieldSetters.current[key] = (node) => { fieldNodes.current[key] = node; };
    }
    return fieldSetters.current[key];
  };

  // 可见下沿取「滚动区底部」和「键盘顶边」里更靠上的那个：
  // 窗口被键盘压缩（adjustResize）和键盘直接盖在窗口上两种模式都能算对
  const ensureFieldVisible = useCallback((key) => {
    const run = () => {
      const node = fieldNodes.current[key];
      const sv = formScrollRef.current;
      if (!node || !sv) return;
      if (typeof node.measureInWindow !== 'function' || typeof sv.measureInWindow !== 'function') return;
      sv.measureInWindow((sx, sy, sw, sh) => {
        node.measureInWindow((x, y, w, h) => {
          if (!h || !sh) return;
          const kbTop = keyboardTopY.current;
          const bottomLimit = Math.min(sy + sh, kbTop != null ? kbTop - 16 : Infinity);
          const topLimit = sy + 12;
          let delta = 0;
          if (y + h > bottomLimit) delta = y + h - bottomLimit;
          else if (y < topLimit) delta = y - topLimit;
          if (Math.abs(delta) > 1) {
            sv.scrollTo({ y: Math.max(0, formScrollY.current + delta), animated: true });
          }
        });
      });
    };
    // 键盘弹出有动画：先量一次，动画结束后再校正一次（第二次已经可见时是空操作）
    setTimeout(run, 80);
    setTimeout(run, 320);
  }, []);

  const handleFieldFocus = useCallback((key) => {
    focusedField.current = key;
    ensureFieldVisible(key);
  }, [ensureFieldVisible]);

  // 键盘弹起时给内容底部留出余量（表单最下面那几个字段才滚得上来）
  const scrollContentStyle = useMemo(
    () => ({ paddingBottom: keyboardOpen ? 280 : (route.name !== 'Edit' ? 78 : 16) }),
    [keyboardOpen, route.name]
  );

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e) => {
      const top = e?.endCoordinates?.screenY;
      keyboardTopY.current = typeof top === 'number' ? top : null;
      setKeyboardOpen(true);
      // 键盘动画走完后再校正一次当前字段的位置
      const key = focusedField.current;
      if (key) setTimeout(() => ensureFieldVisible(key), 300);
    };
    const onHide = () => {
      keyboardTopY.current = null;
      setKeyboardOpen(false);
    };
    const subs = [
      Keyboard.addListener(showEvt, onShow),
      Keyboard.addListener(hideEvt, onHide),
    ];
    if (Platform.OS === 'ios') subs.push(Keyboard.addListener('keyboardDidShow', onShow));
    return () => subs.forEach((s) => s.remove());
  }, [ensureFieldVisible]);

  // 字段的填写顺序（随类型变化）；评论是多行输入，回车留给换行，所以永远排在最后
  const fieldOrder = useMemo(() => {
    const head = baseType === 'ticket' ? ['origin', 'dest', 'no']
      : baseType === 'note' ? ['noteTitle']
        : ['search'];
    const dates = Platform.OS === 'ios'
      ? []
      : (baseType === 'ticket' ? ['year', 'month', 'day', 'hour', 'minute'] : ['year', 'month', 'day']);
    const tail = baseType === 'note' ? ['moodDraft', 'comment'] : ['comment'];
    return [...head, ...dates, ...tail];
  }, [baseType]);

  const pickerDateValue = useMemo(() => {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) && y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d, 12, 0, 0);
    }
    return new Date();
  }, [year, month, day]);

  const pickerTimeValue = useMemo(() => {
    const d = new Date();
    const h = parseInt(hour, 10);
    const min = parseInt(minute, 10);
    if (Number.isFinite(h) && h >= 0 && h <= 23) d.setHours(h);
    if (Number.isFinite(min) && min >= 0 && min <= 59) d.setMinutes(min);
    d.setSeconds(0);
    return d;
  }, [hour, minute]);

  const handleNativeDateChange = useCallback((_event, date) => {
    if (!date) return;
    hapticSelection();
    setYear(String(date.getFullYear()));
    setMonth(String(date.getMonth() + 1).padStart(2, '0'));
    setDay(String(date.getDate()).padStart(2, '0'));
  }, []);

  const handleNativeTimeChange = useCallback((_event, date) => {
    if (!date) return;
    hapticSelection();
    setHour(String(date.getHours()).padStart(2, '0'));
    setMinute(String(date.getMinutes()).padStart(2, '0'));
  }, []);

  const focusField = useCallback((key) => {
    const node = fieldNodes.current[key];
    if (node && typeof node.focus === 'function') node.focus();
  }, []);

  const focusNext = useCallback((key) => {
    const i = fieldOrder.indexOf(key);
    if (i >= 0 && i < fieldOrder.length - 1) focusField(fieldOrder[i + 1]);
  }, [fieldOrder, focusField]);

  // 单行输入框的统一属性：回车跳下一项、保持键盘不收起；iOS 自带原生清除按钮
  const nextFieldProps = (key) => ({
    ref: fieldRef(key),
    returnKeyType: 'next',
    blurOnSubmit: false,
    ...(Platform.OS === 'ios' && key !== 'moodDraft' ? { clearButtonMode: 'while-editing' } : {}),
    onFocus: () => handleFieldFocus(key),
    onSubmitEditing: () => focusNext(key),
  });

  // 年/月/日/时/分：只收数字，填满这一格就自动跳到下一格
  const dateFieldProps = (key, maxLen, value, setValue) => ({
    ...nextFieldProps(key),
    value,
    keyboardType: 'number-pad',
    maxLength: maxLen,
    onChangeText: (t) => {
      const digits = String(t || '').replace(/[^0-9]/g, '').slice(0, maxLen);
      setValue(digits);
      if (digits.length === maxLen) focusNext(key);
    },
  });

  // 把表单草稿里挂着的影像登记出去：侧边栏「同步相册影像」清理孤儿副本时，
  // 这些还在草稿里、没保存的图要算"被引用"，不能被当成多余的删掉
  useEffect(() => { setDraftMediaEntries(selectedImages); }, [selectedImages]);
  useEffect(() => () => setDraftMediaEntries([]), []);
  // 侧边栏「数据目录」里点了"清空添加页草稿"：把表单和草稿保护一起清掉，
  // 那批副本就变成没人引用的孤儿，同步 / 清理时能删（否则常驻 tab 会让它们永远留着）
  useEffect(() => onAddDraftReset(() => {
    setSelectedImages([]);
    setDraftMediaEntries([]);
  }), []);

  useEffect(() => {
    if (route.params?.editItem) {
      const item = route.params.editItem;
      setEditId(item.id);
      setBaseType(item.baseType);
      setSubType(item.subType);
      setRating(item.rating || 0);
      setCoverUrl(item.coverUrl || null);
      setCoverRatio(item.coverRatio || null);
      setEditCoverIndex(item.coverIndex != null ? item.coverIndex : null);
      setEditPhotoCount((item.localImages || []).length);
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
      if (item.baseType === 'note') {
        // 随笔：标题选填，正文放在 subtitle，心情必填，日记还带天气
        setNoteTitle(item.title || '');
        setMood(item.mood || null);
        setWeather(item.weather || null);
        setMoodDraft(MOOD_OPTIONS.includes(item.mood) ? '' : (item.mood || ''));
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
          candidates = await fetchPlaceSuggestions(searchQuery.trim(), loc, controller.signal);
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
  }, [searchQuery, baseType, subType, loc, searchFocused]);

  // 旅票出发地/目的地：天地图地名联想（isPrompt 的联想词无坐标，选中后拿它继续搜）
  useEffect(() => {
    if (baseType !== 'ticket') return;
    if (skipOriginSearch.current) { skipOriginSearch.current = false; return; }
    if (!originFocused) { setOriginResults([]); setShowOriginAuto(false); return; }
    if (!ticketOrigin.trim()) { setOriginResults([]); setShowOriginAuto(false); return; }
    const controller = new AbortController();
    const t = setTimeout(() => {
      fetchPlaceSuggestions(ticketOrigin, loc, controller.signal)
        .then(results => { setOriginResults(results); setShowOriginAuto(true); })
        .catch(error => {
          if (error?.name !== 'AbortError' && Platform.OS === 'android') {
            ToastAndroid.show('出发地联想失败：' + (error.message || error), ToastAndroid.SHORT);
          }
        });
    }, 300);
    return () => { controller.abort(); clearTimeout(t); };
  }, [ticketOrigin, baseType, loc, originFocused]);

  useEffect(() => {
    if (baseType !== 'ticket') return;
    if (skipDestSearch.current) { skipDestSearch.current = false; return; }
    if (!destFocused) { setDestResults([]); setShowDestAuto(false); return; }
    if (!ticketDest.trim()) { setDestResults([]); setShowDestAuto(false); return; }
    const controller = new AbortController();
    const t = setTimeout(() => {
      fetchPlaceSuggestions(ticketDest, loc, controller.signal)
        .then(results => { setDestResults(results); setShowDestAuto(true); })
        .catch(error => {
          if (error?.name !== 'AbortError' && Platform.OS === 'android') {
            ToastAndroid.show('目的地联想失败：' + (error.message || error), ToastAndroid.SHORT);
          }
        });
    }, 300);
    return () => { controller.abort(); clearTimeout(t); };
  }, [ticketDest, baseType, loc, destFocused]);

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
        const list = Array.isArray(picked) ? picked : [];
        const existing = new Set(selectedImages.map(mediaKey).filter(Boolean));
        const seen = new Set();
        const fresh = list.filter((p) => {
          const k = mediaKey(p);
          if (!k || existing.has(k) || seen.has(k)) return false;   // 已经在表单里 / 这一批里重复
          if (p?.assetId && usedElsewhere.has(p.assetId)) return false;
          seen.add(k);
          return true;
        });
        const skipped = list.length - fresh.length;
        if (skipped > 0 && Platform.OS === 'android') {
          ToastAndroid.show(`已跳过 ${skipped} 张重复的照片`, ToastAndroid.SHORT);
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
          // iOS 的 expo-media-library 返回字符串形式的经纬度，这里统一转成有限数字
          const lat = Number(loc.latitude);
          const lng = Number(loc.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            setPhotoCoord({ longitude: lng, latitude: lat });
            if (Platform.OS === 'android') ToastAndroid.show('已从照片读取位置', ToastAndroid.SHORT);
            return;
          }
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
    hapticSelection();
    if (rating === s - 0.5) setRating(s); 
    else if (rating === s) setRating(0); 
    else setRating(s - 0.5); 
  };

  // 出发地/目的地落库：联想选中的坐标优先，没选中则天地图地理编码兜底；名称始终保留
  const resolvePlace = async (name, coord) => {
    if (!name.trim()) return null;
    let lng = coord ? coord.lng : null, lat = coord ? coord.lat : null;
    if (lng == null && hasLocationSearch(loc)) {
      const g = await fetchPlaceGeocode(name, loc).catch(() => null);
      if (g) { lng = g.lng; lat = g.lat; }
    }
    return { name: name.trim(), longitude: lng, latitude: lat };
  };

  /* ---------------- 「已经有相关记录」提醒 ----------------
     基本信息填完（类型 / 名称或行程 / 日期，不含评分·评论·影像）之后，
     如果**同一天**已经有同一个地点、同一条行程、同名作品的记录，就在表单里提示一下。
     要求日期也相同：同一个地点不同日子再去、同一部电影改天二刷，都不该被当成重复。
     只是提醒：照样能保存。 */
  const basicsReady = !!year && !!month && !!day && (
    baseType === 'ticket' ? !!(ticketOrigin.trim() && ticketDest.trim())
      : baseType === 'note' ? !!(noteTitle.trim() || comment.trim())
        : !!searchQuery.trim()
  );
  const relatedRecords = useMemo(() => {
    if (!basicsReady) return [];
    const pad = (v) => String(v).trim().padStart(2, '0');
    const wantDate = `${String(year).trim()}-${pad(month)}-${pad(day)}`;
    const wantTitle = normKey(baseType === 'note' ? (noteTitle.trim() || comment.trim().split('\n')[0]) : searchQuery);
    const wantFrom = normKey(ticketOrigin);
    const wantTo = normKey(ticketDest);
    const wantNo = normKey(ticketNo);
    // 地点：坐标 200 米内就算同一个地方（检索结果的微小差异不该被当成两个地方）
    const nearBy = (c) => {
      if (!locationCoords || !c || c.latitude == null || c.longitude == null) return false;
      const dy = (c.latitude - locationCoords.lat) * 111320;
      const dx = (c.longitude - locationCoords.lng) * 111320 * Math.cos((c.latitude * Math.PI) / 180);
      return Math.sqrt(dx * dx + dy * dy) <= 200;
    };
    return logData
      .filter((it) => it && it.id !== editId && it.baseType === baseType)
      // 日期必须一致（旅票的 date 带时分，这里只比日期部分）
      .filter((it) => String(it.date || '').slice(0, 10) === wantDate)
      .filter((it) => {
        if (baseType === 'ticket') {
          const sameRoute = !!wantFrom && !!wantTo
            && normKey(it.start?.name) === wantFrom && normKey(it.end?.name) === wantTo;
          const sameNo = !!wantNo && normKey(it.subtitle) === wantNo;
          return sameRoute || sameNo;
        }
        if (baseType === 'location') return (!!wantTitle && normKey(it.title) === wantTitle) || nearBy(it.coordinates);
        return !!wantTitle && normKey(it.title) === wantTitle;
      })
      .slice(0, 5);
  }, [basicsReady, year, month, day, baseType, noteTitle, comment, searchQuery, ticketOrigin, ticketDest, ticketNo, locationCoords, logData, editId]);

  // 真正落库的那一段（校验在 handleSave 里做完才进来）
  const performSave = async () => {
    // 随笔：心情必填（emoji 预设或自填任一）
    const essayMood = MOOD_OPTIONS.includes(mood) ? mood : (mood || moodDraft.trim());

    // 豆瓣/Steam/百科的海报下载到本地持久目录，列表封面离线也能显示。
    // 限时 8 秒：网络卡住时不能让"保存"一直没反应（超时就先存网络地址，之后还能显示）
    const coverAssets = baseType === 'media' && coverUrl
      ? await withTimeout(downloadRemoteCoverVariants(coverUrl), 10000)
        .catch(() => ({ coverUrl, coverThumbUrl: coverUrl }))
      : null;
    const existingItem = route.params?.editItem || null;
    // 编辑时如果封面没换，保留原来的小图；换封面才用这次下载的新尺寸
    const coverThumbUrl = coverAssets
      ? (coverAssets.coverUrl === existingItem?.coverUrl
        ? (existingItem?.coverThumbUrl || null)
        : coverAssets.coverThumbUrl)
      : existingItem?.coverThumbUrl || null;

    // 只有存在本地副本（旧数据/系统选择器时代）才需要重链；
    // 应用内选图器产物是纯相册引用，保存零扫描零等待
    const hasCopies = selectedImages.some(e => isAppOwnedMediaPath(mediaUri(e)));
    if (hasCopies && Platform.OS === 'android') {
      ToastAndroid.show('正在关联相册照片…', ToastAndroid.LONG);
    }
    const relink = await relinkNewEntries(selectedImages);
    if (relink.keptCount > 0 && Platform.OS === 'android') {
      ToastAndroid.show(
        `${relink.keptCount} 张照片将以副本保存（${relink.reason || '未能关联到相册原片'}），可在"同步相册影像"中重试`,
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
      if (lng == null && hasLocationSearch(loc)) {
        const g = await fetchPlaceGeocode(searchQuery, loc).catch(() => null);
        if (g) { lng = g.lng; lat = g.lat; }
      }
      if (lng != null && lat != null) coordinates = { latitude: lat, longitude: lng };
    }

    // 随笔：标题选填（空则取正文首行），正文存 subtitle；有照片时默认第一张当封面
    const essayTitle = () => {
      const typed = noteTitle.trim();
      if (typed) return typed;
      const firstLine = comment.trim().split('\n')[0].trim();
      if (firstLine) return firstLine.length > 18 ? `${firstLine.slice(0, 18)}…` : firstLine;
      return subType === 'diary' ? '未命名日记' : '未命名事迹';
    };

    const logDataToSave = {
      id: editId || Date.now(),
      baseType,
      subType,
      title: baseType === 'ticket' ? `${ticketOrigin} → ${ticketDest}`
        : baseType === 'note' ? essayTitle()
        : searchQuery || '未命名记录',
      subtitle: baseType === 'ticket' ? ticketNo : comment,
      // 旅票的 subtitle 被车次/航班号占用，评论单独存字段，否则保存时会丢掉
      comment: baseType === 'ticket' && comment.trim() ? comment : null,
      // 随笔：心情必填，天气只有日记有；评分不参与
      mood: baseType === 'note' ? essayMood : null,
      weather: baseType === 'note' && subType === 'diary' ? (weather || null) : null,
      // 时间选填：填了才拼进日期，不填只存日期（不再出现 00:00 凑数时间）
      // 只有旅票带时分（出发时间有意义），其余类型只存日期
      date: `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`
        + (baseType === 'ticket' && (hour || minute)
          ? ` ${(hour || '00').padStart(2,'0')}:${(minute || '00').padStart(2,'0')}`
          : ''),
      rating: baseType === 'note' ? null : (rating > 0 ? rating : null),
      start,
      end,
      localImages: relink.entries.map((entry) => ({
        ...entry,
        liveStatus: entry.liveStatus || (isVideoEntry(entry) ? 'not-applicable' : 'pending'),
      })),
      coverUrl: coverAssets?.coverUrl || existingItem?.coverUrl || null,
      coverThumbUrl,
      coverRatio: coverAssets?.coverUrl ? coverRatio : existingItem?.coverRatio || null,
      // 随笔不自动指定封面（在详情里长按照片才会设）；编辑时照片没变就保留原来选的封面
      coverIndex: baseType !== 'note' ? undefined
        : (editId ? (editCoverIndex != null && editPhotoCount === relink.entries.length ? editCoverIndex : null) : undefined),
      coordinates,
    };

    if (editId) {
      updateLog(logDataToSave);
    } else {
      addLog(logDataToSave);
    }

    // 重链成功的条目已指向相册原片，留下的副本直接删掉。
    // 必须走 deletePathAsync（原生删除）：Android/data 里的文件用 expo-file-system
    // 的 deleteAsync 一定报 "isn't deletable"，副本就永远清不掉（见 storagePaths）
    for (const uri of relink.replacedUris) {
      await deletePathAsync(uri);
    }

    clearForm();
    // 统一返回策略：二级页保存/取消都直接回主界面
    if (route.name === 'Edit') {
      navigation.popToTop();
    } else {
      navigation.navigate('Main', { screen: 'Home' });
    }
  };

  // 点「保存」的入口：必填校验 → 防连点 → 失败兜底。
  // 以前没有"正在保存"这个状态：重链相册 / 下载封面偶尔卡住时，
  // 界面看起来就是"点了保存没反应"；连点两次还会存出两条一样的记录。
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    if (savingRef.current) return;
    if (!year || !month || !day) {
      Alert.alert('提示', '请至少填写完整的年月日');
      return;
    }
    // 随笔：心情必填（emoji 预设或自填任一）
    const moodNow = MOOD_OPTIONS.includes(mood) ? mood : (mood || moodDraft.trim());
    if (baseType === 'note' && !moodNow) {
      Alert.alert('提示', '随笔需要选一个心情');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await performSave();
      hapticSuccess();
    } catch (e) {
      Alert.alert('保存失败', `保存时出现问题：${e?.message || e}\n可以再试一次。`);
    } finally {
      savingRef.current = false;
      setSaving(false);
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
              <TouchableOpacity key={s} onPress={() => handleStarPress(s)} delayPressIn={0} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                {isHalf ? <StarHalf size={32} color={colors.star} fill={colors.star} style={{ marginRight: 8 }} /> : <Star size={32} color={isFull ? colors.star : colors.starEmpty} fill={isFull ? colors.star : "transparent"} style={{ marginRight: 8 }} />}
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
        <TouchableOpacity
          style={styles.headerCircle}
          delayPressIn={0}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          onPress={() => { clearForm(); if (route.name === 'Edit') { navigation.popToTop(); } else { navigation.navigate('Main', { screen: 'Home' }); } }}
          accessibilityRole="button"
          accessibilityLabel="取消"
        >
          <NativeIcon name="xmark" fallback={X} size={17} color={colors.textSecondary} weight="semibold" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{editId ? '编辑印记' : '新印记'}</Text>
        <TouchableOpacity
          style={[styles.headerCircle, styles.headerSaveCircle]}
          delayPressIn={0}
          onPress={() => { Keyboard.dismiss(); handleSave(); }}
          disabled={saving}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="保存"
        >
          {saving
            ? <ActivityIndicator size="small" color={colors.textOnAccent} />
            : <NativeIcon name="checkmark" fallback={Check} size={17} color={colors.textOnAccent} weight="bold" />}
        </TouchableOpacity>
      </View>

      <View style={styles.formCard}>
        <ScrollView
          ref={formScrollRef}
          style={styles.formScroll}
          showsVerticalScrollIndicator={false}
          bounces={Platform.OS === 'ios'}
          overScrollMode="never"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
          scrollEventThrottle={16}
          onScroll={(e) => { formScrollY.current = e.nativeEvent.contentOffset.y; }}
          contentContainerStyle={[styles.formContent, scrollContentStyle]}
        >
          {/* 类型字段：在表单顶部就地展开大类 / 子类，避免从底部弹层再选一次 */}
          <TouchableOpacity
            style={styles.typeRow}
            onPress={() => { hapticSelection(); setSheetBase(baseType); setTypeMenuOpen(v => !v); }}
            activeOpacity={0.75}
            delayPressIn={0}
          >
            <Text style={styles.typeLabel}>类型</Text>
            <Text style={styles.typeValue}>
              {baseType === 'location' ? '地点' : `${BASE_LABEL[baseType] || ''} · ${SUB_LABEL[subType] || ''}`}
            </Text>
            {typeMenuOpen
              ? <NativeIcon name="chevron.down" fallback={ChevronDown} size={14} color={colors.textFaint} weight="semibold" />
              : <NativeIcon name="chevron.right" fallback={ChevronRight} size={14} color={colors.textFaint} weight="semibold" />}
          </TouchableOpacity>

          {typeMenuOpen && (
            <View style={styles.typeMenu}>
              <View style={styles.typeMenuCats}>
                {TYPE_MENU.map((cat) => {
                  const on = sheetBase === cat.id;
                  return (
                    <TouchableOpacity
                      key={cat.id}
                      style={[styles.typeMenuCat, on && styles.typeMenuCatOn]}
                      delayPressIn={0}
                      onPress={() => { hapticSelection(); chooseCategory(cat.id); }}
                    >
                      <NativeIcon name={cat.sfName} fallback={cat.Icon} size={15} color={on ? colors.accent : colors.textSecondary} />
                      <Text style={[styles.typeMenuCatText, on && styles.typeMenuCatTextOn]}>{cat.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {sheetBase !== 'location' && (
                <View style={styles.typeMenuSubs}>
                  {SUB_OPTIONS[sheetBase].map((opt) => {
                    const active = sheetBase === baseType && subType === opt.id;
                    return (
                      <TouchableOpacity
                        key={opt.id}
                        style={[styles.typeMenuSub, active && styles.typeMenuSubOn]}
                        delayPressIn={0}
                        onPress={() => { hapticSelection(); applyType(sheetBase, opt.id); setTypeMenuOpen(false); }}
                      >
                        <Text style={[styles.typeMenuSubText, active && styles.typeMenuSubTextOn]}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>
          )}
          {baseType === 'ticket' && (
            <View style={{ zIndex: 10 }}>
              <Text style={styles.inputLabel}>出发地</Text>
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  {...nextFieldProps('origin')}
                  value={ticketOrigin}
                  onChangeText={setTicketOrigin}
                  onFocus={() => { setOriginFocused(true); if (ticketOrigin.trim()) setShowOriginAuto(true); handleFieldFocus('origin'); }}
                  onBlur={() => { setOriginFocused(false); setTimeout(() => setShowOriginAuto(false), 200); }}
                  onSubmitEditing={() => { setShowOriginAuto(false); focusNext('origin'); }}
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
                  {...nextFieldProps('dest')}
                  value={ticketDest}
                  onChangeText={setTicketDest}
                  onFocus={() => { setDestFocused(true); if (ticketDest.trim()) setShowDestAuto(true); handleFieldFocus('dest'); }}
                  onBlur={() => { setDestFocused(false); setTimeout(() => setShowDestAuto(false), 200); }}
                  onSubmitEditing={() => { setShowDestAuto(false); focusNext('dest'); }}
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
              <Text style={[styles.inputLabel, { marginTop: 16 }]}>{TICKET_NO_LABEL[subType] || '票号'}</Text>
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  {...nextFieldProps('no')}
                  value={ticketNo}
                  onChangeText={setTicketNo}
                />
              </View>
            </View>
          )}

          {baseType === 'location' && (
            <View style={{ zIndex: 10 }}>
              <Text style={styles.inputLabel}>地点名称</Text>
              <View style={styles.inputWrapper}>
                <MapPin size={18} color={colors.textMuted} style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.input}
                  {...nextFieldProps('search')}
                  value={searchQuery}
                  onChangeText={(t) => {
                    // 手改名称视为"别名"：坐标跟随选中的地点，改名不影响标点位置
                    setSearchQuery(t);
                    if (t.trim().length === 0) { setShowSearchAuto(false); setSearchResults([]); }
                  }}
                  onFocus={() => { setSearchFocused(true); if (searchQuery.trim().length > 0) setShowSearchAuto(true); handleFieldFocus('search'); }}
                  onBlur={() => { setSearchFocused(false); setTimeout(() => setShowSearchAuto(false), 200); }}
                  onSubmitEditing={() => { setShowSearchAuto(false); focusNext('search'); }}
                />
              </View>

              {hasLocationSearch(loc) && showSearchAuto && searchResults.length > 0 && (
                <Reanimated.View entering={FadeIn.duration(150)} style={[styles.autoCompleteBox, { top: 75 }]}>
                  {isSearching ? (
                    <View style={{ padding: 16, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color={colors.accent} />
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
                <Search size={18} color={colors.textMuted} style={{ marginRight: 8 }} />
                <TextInput 
                  style={styles.input} 
                  {...nextFieldProps('search')}
                  value={searchQuery} 
                  onChangeText={(t) => {
                    setSearchQuery(t);
                    setCoverUrl(null); setCoverRatio(null); // 手动改动标题后，之前的网络封面不再匹配
                    if(t.trim().length === 0) { setShowSearchAuto(false); setSearchResults([]); }
                  }}
                  onFocus={() => { setSearchFocused(true); if(searchQuery.trim().length > 0) setShowSearchAuto(true); handleFieldFocus('search'); }}
                  onBlur={() => { setSearchFocused(false); setTimeout(() => setShowSearchAuto(false), 200); }}
                  onSubmitEditing={() => { setShowSearchAuto(false); focusNext('search'); }}
                />
              </View>

              {showSearchAuto && searchResults.length > 0 && (
                <Reanimated.View entering={FadeIn.duration(150)} style={[styles.autoCompleteBox, { top: 75 }]}>

                  {isSearching ? (
                    <View style={{ padding: 16, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color={colors.accent} />
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

          {baseType === 'note' && (
            <View>
              <Text style={styles.inputLabel}>标题（选填）</Text>
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  {...nextFieldProps('noteTitle')}
                  value={noteTitle}
                  onChangeText={setNoteTitle}
                  placeholder={subType === 'diary' ? '给今天起个名字' : '发生了一件什么事'}
                  placeholderTextColor={colors.textMuted}
                />
              </View>
            </View>
          )}

          <View style={styles.divider} />

          <View>
            {Platform.OS === 'ios' ? (
              <>
                <View style={styles.nativeDateRow}>
                  <Text style={[styles.inputLabel, { marginBottom: 0 }]}>发生日期</Text>
                  <DateTimePicker
                    value={pickerDateValue}
                    mode="date"
                    display="compact"
                    locale="zh-CN"
                    themeVariant={isDark ? 'dark' : 'light'}
                    accentColor={colors.accent}
                    onChange={handleNativeDateChange}
                  />
                </View>
                {baseType === 'ticket' && (
                  <View style={[styles.nativeDateRow, { marginTop: 12 }]}>
                    <Text style={[styles.inputLabel, { marginBottom: 0 }]}>具体时间（选填）</Text>
                    {hour || minute ? (
                      <View style={styles.nativeTimeRight}>
                        <DateTimePicker
                          value={pickerTimeValue}
                          mode="time"
                          display="compact"
                          locale="zh-CN"
                          themeVariant={isDark ? 'dark' : 'light'}
                          accentColor={colors.accent}
                          onChange={handleNativeTimeChange}
                        />
                        <TouchableOpacity
                          style={styles.nativeTimeClearBtn}
                          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                          onPress={() => { hapticSelection(); setHour(''); setMinute(''); }}
                        >
                          <Text style={styles.nativeTimeClearText}>清除</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <TouchableOpacity
                        style={styles.nativeTimeAddBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        onPress={() => {
                          hapticSelection();
                          const now = new Date();
                          setHour(String(now.getHours()).padStart(2, '0'));
                          setMinute(String(now.getMinutes()).padStart(2, '0'));
                        }}
                      >
                        <Text style={styles.nativeTimeAddText}>添加时间</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </>
            ) : (
              <>
                <Text style={styles.inputLabel}>发生日期</Text>
                <View style={styles.dateRow}>
                  <TextInput style={[styles.dateBox, styles.dateBoxYear]} {...dateFieldProps('year', 4, year, setYear)} />
                  <Text style={styles.dateLabelText}>年</Text>
                  <TextInput style={styles.dateBox} {...dateFieldProps('month', 2, month, setMonth)} />
                  <Text style={styles.dateLabelText}>月</Text>
                  <TextInput style={styles.dateBox} {...dateFieldProps('day', 2, day, setDay)} />
                  <Text style={styles.dateLabelText}>日</Text>
                </View>

                {/* 只有旅票填时分；列表里只显示日期，具体时分开详情页看 */}
                {baseType === 'ticket' && (
                  <View style={{ marginTop: 12 }}>
                    <Text style={styles.inputLabel}>具体时间（选填）</Text>
                    <View style={styles.dateRow}>
                      <TextInput style={styles.dateBox} {...dateFieldProps('hour', 2, hour, setHour)} />
                      <Text style={styles.dateLabelText}>时</Text>
                      <TextInput style={styles.dateBox} {...dateFieldProps('minute', 2, minute, setMinute)} />
                      <Text style={styles.dateLabelText}>分</Text>
                    </View>
                  </View>
                )}
              </>
            )}
          </View>

          <View style={styles.divider} />
          {/* 同一天已经记过同一个地方 / 同一段行程 / 同一部作品时提醒一下（不拦保存） */}
          {relatedRecords.length > 0 && (
            <TouchableOpacity
              style={styles.dupNote}
              activeOpacity={0.85}
              onPress={() => openRelatedRecord(relatedRecords[0])}
            >
              <Text style={styles.dupNoteTitle}>这一天已经有 {relatedRecords.length} 条相关记录</Text>
              <Text style={styles.dupNoteBody} numberOfLines={2}>
                最近一条：{relatedRecords[0].title}
              </Text>
              <Text style={styles.dupNoteHint}>点一下打开那条记录（只是提醒，不影响保存）</Text>
            </TouchableOpacity>
          )}
          {/* 随笔用心情 emoji 代替评分；心情必填 */}
          {baseType === 'note' ? (
            <View style={styles.ratingSection}>
              <Text style={styles.inputLabel}>心情 <Text style={styles.requiredMark}>*</Text></Text>
              <View style={styles.moodRow}>
                {MOOD_OPTIONS.map((m) => {
                  const on = mood === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      style={[styles.moodChip, on && styles.moodChipOn]}
                      delayPressIn={0}
                      onPress={() => { hapticSelection(); setMood(on ? null : m); setMoodDraft(''); }}
                    >
                      <Text style={styles.moodChipText}>{m}</Text>
                    </TouchableOpacity>
                  );
                })}
                <TextInput
                  style={[styles.moodInput, (moodDraft.trim() && !MOOD_OPTIONS.includes(mood)) && styles.moodChipOn]}
                  {...nextFieldProps('moodDraft')}
                  value={moodDraft}
                  onChangeText={(t) => { setMoodDraft(t); setMood(t ? t : null); }}
                  placeholder="自填"
                  placeholderTextColor={colors.textMuted}
                  maxLength={4}
                />
              </View>
            </View>
          ) : renderRating()}
          <View style={[styles.divider, { marginVertical: 12 }]} />

          <View>
            <View style={styles.labelRow}>
              <Text style={[styles.inputLabel, styles.labelRowText]}>{baseType === 'note' ? '内容' : '评论'}</Text>
              {/* 内容写长了可以进全屏编辑 */}
              <TouchableOpacity
                style={styles.expandBtn}
                onPress={() => { hapticSelection(); setFullscreenComment(true); }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <NativeIcon name="arrow.up.left.and.arrow.down.right" fallback={Maximize2} size={13} color={colors.accent} />
                <Text style={styles.expandBtnText}>全屏</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.commentInput}
              ref={fieldRef('comment')}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              onFocus={() => handleFieldFocus('comment')}
              value={comment}
              onChangeText={setComment}
              placeholder={baseType === 'note' ? '写点什么…' : '写点评论…'}
              placeholderTextColor={colors.textMuted}
            />
          </View>

          {baseType === 'note' && subType === 'diary' && (
            <>
              <View style={styles.divider} />
              <View>
                <Text style={styles.inputLabel}>天气（选填）</Text>
                <View style={styles.moodRow}>
                  {WEATHER_OPTIONS.map((w) => {
                    const on = weather === w;
                    return (
                      <TouchableOpacity
                        key={w}
                        style={[styles.weatherChip, on && styles.moodChipOn]}
                        delayPressIn={0}
                        onPress={() => { hapticSelection(); setWeather(on ? null : w); }}
                      >
                        <Text style={[styles.weatherChipText, on && styles.weatherChipTextOn]}>{w}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </>
          )}

          <View style={styles.divider} />

          <View>
            {/* 各类型统一叫「照片」：以前旅票是"票根 / 留影"、娱乐/地点是"现场影像 / 截图"，
                同一个东西三个名字，容易看混 */}
            <Text style={styles.inputLabel}>照片 ({selectedImages.length})</Text>
            <View style={styles.imageGrid}>
              {selectedImages.map((entry, idx) => (
                <View key={idx} style={styles.imageGridItem}>
                  {isVideoEntry(entry) ? (
                    <VideoPreview entry={entry} />
                  ) : (
                    <Image source={{ uri: mediaUri(entry) }} style={styles.imageGridImage} contentFit="cover" cachePolicy="memory" />
                  )}
                  <TouchableOpacity
                    style={styles.removeImageBtn}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPress={() => { hapticSelection(); const n = [...selectedImages]; n.splice(idx, 1); setSelectedImages(n); }}
                  >
                    <NativeIcon name="xmark" fallback={X} size={11} color="#FFF" weight="bold" />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={styles.imageGridItem}>
                <TouchableOpacity style={styles.addImageBtn} delayPressIn={0} onPress={openMediaPicker}>
                  <NativeIcon name="photo.badge.plus" fallback={ImagePlus} size={24} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>

      {/* 评论 / 内容全屏编辑：iOS 用原生 pageSheet（支持下拉关闭），写长文时铺满编辑区 */}
      <Modal
        visible={fullscreenComment}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
        onRequestClose={() => setFullscreenComment(false)}
      >
        <KeyboardAvoidingView
          style={[styles.fullscreenWrap, { paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.fullscreenHeader}>
            <TouchableOpacity onPress={() => setFullscreenComment(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.cancelText}>返回</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{baseType === 'note' ? '内容' : '评论'}</Text>
            <TouchableOpacity onPress={() => setFullscreenComment(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.saveText}>完成</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.fullscreenInput}
            multiline
            textAlignVertical="top"
            autoFocus
            value={comment}
            onChangeText={setComment}
            placeholder={baseType === 'note' ? '写点什么…' : '写点评论…'}
            placeholderTextColor={colors.textMuted}
          />
        </KeyboardAvoidingView>
      </Modal>

    </KeyboardAvoidingView>
  );
}

const makeStyles = (c) => ({
  dupNote: {
    marginTop: 12, padding: 12, borderRadius: 12,
    backgroundColor: c.warnSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.warnText,
  },
  dupNoteTitle: { fontSize: 13.5, fontWeight: '600', color: c.warnText },
  // lineHeight 是绝对单位（pt），不是倍数：写成 1.5 会把行高压成 1.5pt，
  // 文字被裁得只剩一条缝——之前"底下那行被遮挡"就是这个
  dupNoteBody: { fontSize: 12, color: c.warnText, marginTop: 4, lineHeight: 18, opacity: 0.92 },
  dupNoteHint: { fontSize: 11, color: c.warnText, marginTop: 6, opacity: 0.7 },
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: 'transparent' },
  headerCircle: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.fill,
  },
  headerSaveCircle: { backgroundColor: c.accent },
  cancelText: { fontSize: 16, color: c.textSecondary },
  headerTitle: { fontSize: 17, fontWeight: '600', color: c.text },
  saveText: { fontSize: 16, fontWeight: '600', color: c.accent },
  formCard: {
    flex: 1, marginHorizontal: 16, marginTop: 10, marginBottom: 0,
    backgroundColor: c.bgElevated, borderRadius: 14, overflow: 'hidden',
  },
  formScroll: { flex: 1 },
  formContent: { padding: 16 },
  typeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bgSunken, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, height: 46, marginBottom: 16 },
  typeLabel: { fontSize: 15, color: c.textMuted, marginRight: 8 },
  typeValue: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text },
  typeMenu: {
    marginTop: -6, marginBottom: 16, padding: 10,
    backgroundColor: c.bgSunken, borderRadius: 14,
    borderWidth: 1, borderColor: c.border,
  },
  typeMenuCats: { flexDirection: 'row', gap: 6 },
  typeMenuCat: {
    flex: 1, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 4, borderWidth: 1, borderColor: c.borderSoft,
    backgroundColor: c.bgElevated,
  },
  typeMenuCatOn: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  typeMenuCatText: { fontSize: 12, color: c.textSecondary, fontWeight: '500' },
  typeMenuCatTextOn: { color: c.accent, fontWeight: '600' },
  typeMenuSubs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  typeMenuSub: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14,
    backgroundColor: c.bgElevated, borderWidth: 1, borderColor: c.borderSoft,
  },
  typeMenuSubOn: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  typeMenuSubText: { fontSize: 12.5, color: c.textSecondary },
  typeMenuSubTextOn: { color: c.accent, fontWeight: '600' },
  sheetContent: { paddingHorizontal: 16, paddingBottom: 24 },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  sheetTitle: { fontSize: 17, fontWeight: '600', color: c.text },
  catRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  catCard: { flex: 1, borderWidth: 1.5, borderColor: c.border, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  catCardActive: { borderColor: c.accent, backgroundColor: c.accentTint },
  catIconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  catEmoji: { fontSize: 19, lineHeight: 24 },
  catLabel: { fontSize: 14, fontWeight: '500', color: c.textSecondary },
  catLabelActive: { color: c.accent, fontWeight: '600' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { paddingVertical: 9, paddingHorizontal: 18, backgroundColor: c.bgSunken, borderWidth: 1, borderColor: c.borderSoft, borderRadius: 19 },
  chipActive: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  chipText: { fontSize: 14, color: c.textSecondary },
  chipTextActive: { color: c.accent, fontWeight: '500' },
  inputLabel: { fontSize: 13, fontWeight: '500', color: c.textMuted, marginBottom: 8 },
  inputWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bgSunken, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, height: 44, marginBottom: 16 },
  input: { flex: 1, fontSize: 15, color: c.text },
  autoCompleteBox: { position: 'absolute', top: 70, left: 0, right: 0, backgroundColor: c.bgElevated, borderRadius: 10, shadowColor: c.shadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4, zIndex: 99, overflow: 'hidden' },
  autoCompleteItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: c.borderSoft },
  autoCompleteThumb: { width: 36, height: 36, borderRadius: 6 },
  autoCompleteText: { fontSize: 15, color: c.text },
  autoCompleteMeta: { fontSize: 12, color: c.textMuted, marginTop: 1 },
  divider: { height: 1, backgroundColor: c.borderSoft, marginVertical: 16 },
  dateRow: { flexDirection: 'row', alignItems: 'center' },
  nativeDateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 38 },
  nativeTimeRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  nativeTimeAddBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    backgroundColor: c.accentSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.accentSoftBorder,
  },
  nativeTimeAddText: { fontSize: 13.5, fontWeight: '600', color: c.accent },
  nativeTimeClearBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  nativeTimeClearText: { fontSize: 13, color: c.textMuted },
  dateBox: { backgroundColor: c.bgSunken, borderWidth: 1, borderColor: c.border, borderRadius: 8, height: 42, width: 48, textAlign: 'center', fontSize: 16, fontWeight: '600', color: c.text },
  dateBoxYear: { width: 64 }, 
  dateLabelText: { fontSize: 14, color: c.textSecondary, marginHorizontal: 6, fontWeight: '500' },
  ratingSection: { marginBottom: 8 },
  starRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  ratingScore: { fontSize: 18, fontWeight: 'bold', color: c.star, marginLeft: 12 },
  requiredMark: { color: c.danger, fontWeight: '700' },
  moodRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  moodChip: { width: 44, height: 42, borderRadius: 12, backgroundColor: c.bgSunken, borderWidth: 1, borderColor: c.border,
    alignItems: 'center', justifyContent: 'center' },
  moodChipOn: { backgroundColor: c.accentSoft, borderColor: c.accentSoftBorder },
  moodChipText: { fontSize: 21, lineHeight: 26 },
  moodInput: { width: 88, height: 42, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border,
    backgroundColor: c.bgSunken, textAlign: 'center', fontSize: 18, color: c.text, paddingVertical: 0 },
  weatherChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: c.bgSunken,
    borderWidth: 1, borderColor: c.border },
  weatherChipText: { fontSize: 13, color: c.textSecondary },
  weatherChipTextOn: { color: c.accent, fontWeight: '600' },
  commentInput: { backgroundColor: c.bgSunken, borderRadius: 10, padding: 12, fontSize: 15, height: 100, color: c.text, borderWidth: 1, borderColor: c.border },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  labelRowText: { marginBottom: 0 },
  expandBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 8, backgroundColor: c.accentSoft },
  expandBtnText: { fontSize: 11.5, color: c.accent, fontWeight: '600' },
  fullscreenWrap: { flex: 1, backgroundColor: c.bg },
  fullscreenHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16,
    paddingVertical: 14, backgroundColor: c.bgElevated, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  fullscreenInput: { flex: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, lineHeight: 24, color: c.text, textAlignVertical: 'top' },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginTop: 4 },
  imageGridItem: { width: '33.33%', padding: 4 },
  imageGridImage: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: c.mediaPlaceholder, overflow: 'hidden' },
  playOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  addImageBtn: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: c.bgSunken, borderWidth: 1, borderColor: c.border, borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center' },
  removeImageBtn: { position: 'absolute', top: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', width: 20, height: 20, borderRadius: 10, justifyContent: 'center', alignItems: 'center' }
});
