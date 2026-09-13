// 实况/动态照片支持：跨厂商四级检测，全程基于分段读，绝不把整张照片加载进内存。
// ① iOS：expo-media-library 的 photoLive 标记 + pairedVideoAsset 配对视频；
// ② 头部 512KB：GCamera XMP 标记（Google/小米/OV 等大多数厂商）；
// ③ 尾部 256KB：三星 SEFT 标记 / 追加式 mp4 的 ftyp（覆盖三星与大部分"JPEG+视频"拼接）；
// ④ 详情页兜底：全文件扫描（覆盖荣耀等无标记拼接格式），只在打开详情时执行。
// 检测结果持久化到 AsyncStorage（assetId+大小为键，照片被替换自动失效），重启不重算。
// mp4 提取沿用 mp4CleanEnd 结构走查，写出干净的 mp4；提取结果落盘缓存，播放秒开。
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import * as FileSystemNew from 'expo-file-system';

const HEADER_BYTES = 512 * 1024; // 头部扫描范围（GCamera XMP 元数据）
const TAIL_BYTES = 256 * 1024;   // 尾部扫描范围（三星 SEFT / 追加 mp4 的 ftyp）
const MAX_DETECT_SIZE = 40 * 1024 * 1024; // 全文件扫描的上限（实况照片远小于此，仅详情页兜底用）
const TAIL_CAP = 16 * 1024 * 1024; // 提取时的尾部扫描上限
const STORE_KEY = '@livephoto_cache';
const STORE_CAP = 5000;

// 会话内存缓存 + 持久化存储（AsyncStorage 单键 JSON，约 150B/条）
const infoCache = new Map();
let storePromise = null;
let persistTimer = null;

const ensureStore = () => {
  if (!storePromise) {
    storePromise = AsyncStorage.getItem(STORE_KEY)
      .then(raw => {
        if (!raw) return;
        const obj = JSON.parse(raw);
        for (const k in obj) if (!infoCache.has(k)) infoCache.set(k, obj[k]);
      })
      .catch(() => {});
  }
  return storePromise;
};

const schedulePersist = () => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const obj = {};
      let n = 0;
      for (const [k, v] of infoCache) {
        obj[k] = v;
        if (++n >= STORE_CAP) break; // 超上限丢弃最早的（Map 保持插入序）
      }
      await AsyncStorage.setItem(STORE_KEY, JSON.stringify(obj));
    } catch {}
  }, 800);
};

const normalizeEntry = (entry) => (typeof entry === 'string' ? { uri: entry } : entry || null);

// 简易字符串哈希：给磁盘缓存的文件命名用（提取的实况视频）
const hashKey = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + '_' + s.length.toString(36);
};

// 解析 GCamera 规格的动态照片标记，返回 { videoLength }（长度可能缺失，缺失时靠尾部扫描兜底）
const parseMotionXmp = (text) => {
  if (!text || text.indexOf('GCamera:') === -1) return null;
  const isV2 = /GCamera:MotionPhoto\s*=\s*"(?:1|true|True|TRUE)"/.test(text);
  const isV1 = /GCamera:MicroVideo\s*=\s*"1"/.test(text);
  if (!isV2 && !isV1) return null;
  let videoLength = null;
  if (isV2) {
    const items = text.match(/<[^<>]*Item:Semantic="MotionPhoto"[^<>]*>/g) || [];
    for (const el of items) {
      const m = el.match(/Item:Length\s*=\s*"(\d+)"/);
      if (m) { videoLength = parseInt(m[1], 10); break; }
    }
  }
  if (videoLength == null) {
    const m = text.match(/GCamera:MicroVideoOffset\s*=\s*"(\d+)"/);
    if (m) videoLength = parseInt(m[1], 10);
  }
  return { videoLength };
};

// mp4 起始框：4 字节 box 长度（首字节为 0 的常规尺寸）+ 'ftyp'。
// 返回最后一个 ftyp 的位置（内嵌视频在文件尾，最后一个才是）
const findLastFtyp = (bytes, from) => {
  let found = -1;
  for (let i = Math.max(0, from); i + 8 <= bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 &&
        bytes[i + 4] === 0x66 && bytes[i + 5] === 0x74 && bytes[i + 6] === 0x79 && bytes[i + 7] === 0x70) {
      found = i;
    }
  }
  return found;
};

// 按 MP4 box 结构顺序走一遍，返回最后一个完整 box 的结束位置。
// 荣耀等厂商会在视频后再拼私有尾数据（官方 LivePhoto 的 offset/length 模型），
// 裁掉后写出的才是干净的 mp4，播放器不会读到脏字节。同时充当 ftyp 兜底判定的结构校验
const mp4CleanEnd = (bytes, start) => {
  let off = start;
  let end = bytes.length;
  while (off + 8 <= bytes.length) {
    const size = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    if (size === 1) {
      // 64-bit largesize：跳过类型后跟 8 字节长度（高 32 位非 0 视为异常，超出实际不可能）
      if (off + 16 > bytes.length) break;
      const hi = (bytes[off + 8] << 24) | (bytes[off + 9] << 16) | (bytes[off + 10] << 8) | bytes[off + 11];
      if (hi !== 0) break;
      const lo = (bytes[off + 12] << 24) | (bytes[off + 13] << 16) | (bytes[off + 14] << 8) | bytes[off + 15];
      if (lo < 16 || off + lo > bytes.length) break;
      off += lo;
      end = off;
    } else if (size >= 8 && off + size <= bytes.length) {
      off += size;
      end = off;
    } else {
      break;
    }
  }
  return end;
};

// 廉价检测（选图器网格用）：头部 XMP + 尾部 SEFT/ftyp，两次分段 UTF8 读，不碰文件中段。
// ASCII 标记（GCamera:/SEFT/ftyp）在 UTF8 解码下不受二进制字节影响
const detectQuick = async (uri, size) => {
  const headLen = Math.min(HEADER_BYTES, size);
  const headText = await FileSystem.readAsStringAsync(uri, {
    position: 0,
    length: headLen,
    encoding: FileSystem.EncodingType.UTF8,
  });
  const parsed = parseMotionXmp(headText);
  if (parsed) return { live: true, videoLength: parsed.videoLength, source: 'xmp' };

  if (size > TAIL_BYTES) {
    const tailText = await FileSystem.readAsStringAsync(uri, {
      position: size - TAIL_BYTES,
      length: TAIL_BYTES,
      encoding: FileSystem.EncodingType.UTF8,
    });
    if (tailText.includes('SEFT') || tailText.includes('ftyp')) {
      return { live: true, source: 'tail' };
    }
  }
  return { live: false, source: 'quick' };
};

// 全文件扫描兜底（详情页专用）：无标记拼接格式（荣耀等）的最后一条路径
const detectFull = async (uri) => {
  const { File } = FileSystemNew;
  const buffer = await new File(uri).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const start = findLastFtyp(bytes, 0);
  if (start > 0) {
    return { live: true, videoLength: bytes.length - start, source: 'scan' };
  }
  return { live: false, source: 'scan' };
};

// 检测媒体条目是否实况/动态照片。
// full=false（网格）：①②③ 廉价检测；full=true（详情页）：追加 ④ 全文件扫描兜底。
// scanned 标记该结果是否已经过全文件扫描——网格的廉价结论在详情页会自动升级，不会被缓存短路。
// 检测结果带照片大小持久化：照片被替换（大小变化）后自动失效重检
export const getLivePhotoInfo = async (entry, { full = false } = {}) => {
  await ensureStore();
  const { uri, assetId } = normalizeEntry(entry) || {};
  const baseKey = assetId || uri || '';
  if (!baseKey) return { live: false };

  // ① iOS：相册元数据直接标记，并给出配对视频（系统判定即最终结论）
  if (Platform.OS === 'ios' && assetId) {
    if (infoCache.has(baseKey)) return infoCache.get(baseKey);
    let out = { live: false, source: 'ios', scanned: true };
    try {
      const info = await MediaLibrary.getAssetInfoAsync(assetId);
      if (info?.mediaSubtypes?.includes?.('photoLive')) {
        out = {
          live: true,
          pairedVideoUri: info.pairedVideoAsset?.localUri || info.pairedVideoAsset?.uri || null,
          source: 'ios',
          scanned: true,
        };
      }
    } catch (e) {
      console.warn('[livePhoto] iOS 检测失败', e?.message || e);
    }
    infoCache.set(baseKey, out);
    schedulePersist();
    return out;
  }

  // Android：文件级检测。键带文件大小，照片被替换后旧结果自动失效
  if (uri && uri.startsWith('file://')) {
    let size = 0;
    try {
      const stat = await FileSystem.getInfoAsync(uri);
      size = stat.exists ? stat.size || 0 : 0;
    } catch {}
    if (size <= 4) return { live: false };

    const key = `${baseKey}|${size}`;
    const cached = infoCache.get(key);
    if (cached && (!full || cached.scanned || cached.live)) return cached;

    try {
      let out;
      if (cached) {
        // 升级路径：网格的廉价检测没认出来的，这里补全文件扫描
        out = { ...await detectFull(uri), size, scanned: true };
      } else {
        // ②③ 头部 XMP + 尾部 SEFT/ftyp 廉价检测
        out = { ...await detectQuick(uri, size), size, scanned: false };
        // ④ 全文件扫描兜底（仅详情页）
        if (!out.live && full && size <= MAX_DETECT_SIZE) {
          out = { ...await detectFull(uri), size, scanned: true };
        }
      }
      infoCache.set(key, out);
      schedulePersist();
      return out;
    } catch (e) {
      console.warn('[livePhoto] 检测失败', uri, e?.message || e);
      if (cached) return cached;
      return { live: false };
    }
  }

  // 其他来源（网络图 / content://）：无法做文件级检测
  if (infoCache.has(baseKey)) return infoCache.get(baseKey);
  return { live: false };
};

// mp4 起始框：4 字节 box 长度（首字节为 0 的常规尺寸）+ 'ftyp'
const isFtypBox = (bytes, i) =>
  i >= 0 && i + 8 <= bytes.length &&
  bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 &&
  bytes[i + 4] === 0x66 && bytes[i + 5] === 0x74 && bytes[i + 6] === 0x79 && bytes[i + 7] === 0x70;

// 提取内嵌的动态视频，返回可播放的本地 mp4 地址；解析失败返回 null（界面回退为静帧展示）。
// 结果落盘缓存，同一张照片只解析一次
export const extractMotionVideo = async (entry, info) => {
  const normalized = normalizeEntry(entry) || {};
  const uri = normalized.uri;
  if (!uri) return null;

  // iOS Live Photo：相册直接给出配对视频，无需解析
  if (info?.pairedVideoUri) return info.pairedVideoUri;
  if (!uri.startsWith('file://')) return null;

  const key = normalized.assetId || uri;
  const dest = `${FileSystem.documentDirectory}motionVideos/${hashKey(key)}.mp4`;
  try {
    const existing = await FileSystem.getInfoAsync(dest);
    if (existing.exists) return dest;
  } catch {}

  try {
    const { File } = FileSystemNew;
    const src = new File(uri);
    const buffer = await src.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // 优先用 XMP 声明的视频长度精确定位；不行就在尾部扫描 mp4 起始框
    let start = -1;
    if (info?.videoLength && info.videoLength > 0 && info.videoLength < bytes.length) {
      const candidate = bytes.length - info.videoLength;
      if (isFtypBox(bytes, candidate)) start = candidate;
    }
    if (start < 0) {
      const from = Math.max(0, bytes.length - TAIL_CAP);
      for (let i = from; i + 8 <= bytes.length; i++) {
        if (isFtypBox(bytes, i)) start = i;
      }
    }
    if (start <= 0) return null;

    const dir = `${FileSystem.documentDirectory}motionVideos`;
    if (!(await FileSystem.getInfoAsync(dir)).exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    const cleanEnd = mp4CleanEnd(bytes, start);
    new File(dest).write(bytes.subarray(start, cleanEnd > start ? cleanEnd : bytes.length));
    return dest;
  } catch (e) {
    console.warn('[livePhoto] 提取动态视频失败', e?.message || e);
    return null;
  }
};
