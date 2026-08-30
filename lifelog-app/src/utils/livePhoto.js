// 实况/动态照片支持：
// - iOS 原生 Live Photo：expo-media-library 的 mediaSubtypes 标记 + pairedVideoAsset 配对视频；
// - Android 动态照片：动态视频内嵌在 JPEG 文件里。各厂商标记不统一
//   （Google/小米有 GCamera XMP，三星有 SEFT，荣耀等则完全没有标记、纯 JPEG+mp4 拼接），
//   所以检测采用通用方案：普通 JPEG 以 FF D9 结尾，实况照片结尾是视频数据——
//   先看文件末尾两字节快速排除绝大多数普通照片，再扫描内嵌 mp4 起始框（ftyp）确认。
// 检测结果会话内缓存；提取的内嵌视频落盘缓存，播放秒开。
import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import * as FileSystemNew from 'expo-file-system';

const HEADER_BYTES = 512 * 1024; // 文件头扫描范围（GCamera XMP 元数据）
const MAX_DETECT_SIZE = 40 * 1024 * 1024; // 超过此大小的文件不做内嵌视频扫描（实况照片远小于此）
const TAIL_CAP = 16 * 1024 * 1024; // 提取时的尾部扫描上限

// assetId|uri -> { live, videoLength, pairedVideoUri }，会话内缓存
const infoCache = new Map();

const hashKey = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + '_' + s.length.toString(36);
};

const normalizeEntry = (entry) => (typeof entry === 'string' ? { uri: entry } : entry || null);

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
// 裁掉后写出的才是干净的 mp4，播放器不会读到脏字节
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

// 检测媒体条目是否实况/动态照片。检测结果会话内缓存，可放心对每个格子调用
export const getLivePhotoInfo = async (entry) => {
  const { uri, assetId } = normalizeEntry(entry) || {};
  const key = assetId || uri || '';
  if (!key) return { live: false };
  if (infoCache.has(key)) return infoCache.get(key);

  let out = { live: false };
  const dbg = { size: 0, xmp: false, ftyp: -1 };
  try {
    // iOS 真 Live Photo：相册元数据直接标记，并给出配对视频
    if (Platform.OS === 'ios' && assetId) {
      const info = await MediaLibrary.getAssetInfoAsync(assetId);
      if (info?.mediaSubtypes?.includes?.('photoLive')) {
        out = {
          live: true,
          pairedVideoUri: info.pairedVideoAsset?.localUri || info.pairedVideoAsset?.uri || null,
        };
      }
    }
    // Android：文件级检测（对所有厂商格式通用）。
    // 注意：legacy readAsStringAsync 的 position/length 局部读在部分设备返回全零字节，不可用，
    // 所以头部解析只做全量可用的 UTF8 读（限制在头部范围），尾字节判断改由整文件扫描覆盖
    if (!out.live && uri && uri.startsWith('file://')) {
      const stat = await FileSystem.getInfoAsync(uri);
      const size = stat.exists ? stat.size || 0 : 0;
      dbg.size = size;
      if (stat.exists && size > 4) {
        // 1) GCamera 系（Google/小米等）：头部 XMP 有标记和精确的视频长度
        const headLen = Math.min(HEADER_BYTES, size);
        const headText = await FileSystem.readAsStringAsync(uri, {
          position: 0,
          length: headLen,
          encoding: FileSystem.EncodingType.UTF8,
        });
        const parsed = parseMotionXmp(headText);
        dbg.xmp = !!parsed;
        if (parsed) {
          out = { live: true, videoLength: parsed.videoLength };
        } else if (size <= MAX_DETECT_SIZE) {
          // 2) 无标记的拼接格式（荣耀等）：读入文件扫描最后一个 mp4 起始框。
          //    纯 JPEG 文件扫描不到 ftyp，成本是一次文件读（结果会话内缓存）
          const { File } = FileSystemNew;
          const buffer = await new File(uri).arrayBuffer();
          const bytes = new Uint8Array(buffer);
          const start = findLastFtyp(bytes, 0);
          dbg.ftyp = start;
          if (start > 0) out = { live: true, videoLength: bytes.length - start };
        }
      }
    }
  } catch (e) {
    console.warn('[livePhoto] 检测失败', uri, e?.message || e);
  }
  console.log('[livePhoto] 检测', JSON.stringify(dbg), '=>', JSON.stringify(out));
  infoCache.set(key, out);
  return out;
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
