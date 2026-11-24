// 实况/动态照片支持：跨厂商四级检测 + 提取，全程基于分段读，绝不把整张照片加载进内存。
// ① iOS：expo-media-library 的 photoLive 标记 + pairedVideoAsset 配对视频；
// ② 头部 512KB：GCamera XMP 标记（Google/小米/OV 等大多数厂商）；
// ③ 尾部 256KB：三星 SEFT 标记 / 追加式 mp4 的 ftyp（覆盖三星与大部分"JPEG+视频"拼接）；
// ④ 详情页兜底：尾部窗口扫描（覆盖荣耀等无标记拼接格式），只在打开详情时执行。
// 检测结果持久化到 AsyncStorage（assetId+大小为键，照片被替换自动失效），重启不重算。
// mp4 提取同样只读尾部窗口（内嵌视频永远在文件最后），沿用 mp4CleanEnd 结构走查写出干净的
// mp4；结果落盘缓存 + 会话内存缓存，同一个文件点第二次是纯切换、零文件 IO。
// 落盘目录 motionVideos 由上层在「进后台 / 下次启动」时整体清空（见 media.clearMotionVideos），
// 所以它只是"这次会话的临时文件"，不占长期存储，也不再需要体积上限。
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import * as FileSystemNew from 'expo-file-system';
import { readFileRangeAsync } from './storagePaths';
import { setLivePhotoError } from './diag';

const HEADER_BYTES = 512 * 1024; // 头部扫描范围（GCamera XMP 元数据）
const TAIL_BYTES = 256 * 1024;   // 尾部扫描范围（三星 SEFT / 追加 mp4 的 ftyp）
const TAIL_STEP = 2 * 1024 * 1024; // 尾部窗口的起始大小（不够就翻倍）
const TAIL_CAP = 16 * 1024 * 1024; // 尾部窗口的上限（实况动效通常 1~3MB，16MB 已经很宽裕）
const STORE_KEY = '@livephoto_cache';
const STORE_CAP = 5000;

// 会话内存缓存 + 持久化存储（AsyncStorage 单键 JSON，约 150B/条）
const infoCache = new Map();
// iOS 配对视频路径落在系统 temporaryDirectory，重启/进后台可能被清理，只放内存不持久化
const iosPairedVideoCache = new Map();
let storePromise = null;
let persistTimer = null;

// expo-media-library v18（SDK 54）返回 'livePhoto'；兼容旧版可能的 'photoLive'
const isIosLiveSubtype = (subtypes) =>
  Array.isArray(subtypes) && (subtypes.includes('livePhoto') || subtypes.includes('photoLive'));

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

/* -------- 按区间读文件：只碰尾部窗口，绝不整文件读 --------
   内嵌的动效永远贴在照片**最后**，从文件尾往里读一个窗口就够了：2MB 起步、不够翻倍、
   上限 TAIL_CAP。以前走 src.arrayBuffer() 整文件读 + 在 JS 里扫全部字节，20~40MB 的
   大图点一次要等好几秒（打开详情页预热时尤其明显）。

   读法用原生 `Paths.readFileRange`（只读打开）：**不能用 expo-file-system 的
   FileHandle** —— 它是 `RandomAccessFile(file, "rw")`，相册里的照片 App 没有写权限，
   一 open 就 EACCES，表现就是"实况提取一直是 0 个文件、数据目录显示暂无"。
   原生模块不在（iOS / 旧构建）时退回整文件读：慢，但一定拿得到（1.9.3 之前就是这条路）。
   返回 { bytes, windowStart, size }；读不了返回 null。 */
const readTailWindow = async (uri, want) => {
  if (!readFileRangeAsync) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    const size = info?.exists && typeof info.size === 'number' ? info.size : 0;
    if (size <= 0) return null;
    const len = Math.max(1, Math.min(size, Math.ceil(want)));
    const windowStart = size - len;
    const bytes = await readFileRangeAsync(uri, windowStart, len);
    if (bytes?.length) return { bytes, windowStart, size };
    // 拿不到原生区间读（旧构建 / iOS）：整文件读兜底，窗口就算整个文件
    const whole = await new FileSystemNew.File(uri).bytes();
    if (!whole?.length) setLivePhotoError('区间读与整文件读都没拿到数据（相册文件可能无法以只读方式打开）');
    return whole?.length ? { bytes: whole, windowStart: 0, size: whole.length } : null;
  } catch (e) {
    console.warn('[livePhoto] 读取文件尾部失败', uri, e?.message || e);
    setLivePhotoError(`读取失败：${e?.message || e}`);
    return null;
  }
};

// 在窗口里定位内嵌 mp4 的起点：优先用 XMP 声明的长度（要正好落在 ftyp 框上），
// 其次找窗口里最后一个 ftyp（三星等没有长度标记的拼接格式）
const findMotionStart = (win, videoLength) => {
  if (videoLength > 0) {
    const at = win.size - videoLength - win.windowStart;
    if (at >= 0 && isFtypBox(win.bytes, at)) return at;
  }
  return findLastFtyp(win.bytes, 0);
};

// 兜底检测（详情页专用）：无标记拼接格式（荣耀等）的最后一条路径。
// 只扫尾部窗口——为了判断"是不是实况"去整文件读 20~40MB 纯属浪费
const detectFull = async (uri) => {
  let want = TAIL_STEP;
  for (;;) {
    const win = await readTailWindow(uri, Math.min(want, TAIL_CAP));
    if (!win) return { live: false, source: 'scan' };
    const start = findLastFtyp(win.bytes, 0);
    if (start > 0) {
      return { live: true, videoLength: win.size - (win.windowStart + start), source: 'scan' };
    }
    if (win.windowStart === 0 || want >= TAIL_CAP) return { live: false, source: 'scan' };
    want *= 2;
  }
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
    const normalized = normalizeEntry(entry) || {};
    const memPaired = iosPairedVideoCache.get(baseKey) || null;
    if (infoCache.has(baseKey)) {
      const cached = infoCache.get(baseKey);
      // 兼容老版本持久化过 pairedVideoUri 的缓存：不盲信旧 tmp 路径，只附带本次会话有效的路径
      return {
        live: !!cached?.live,
        source: cached?.source || 'ios',
        scanned: true,
        ...(cached?.live && memPaired ? { pairedVideoUri: memPaired } : {}),
      };
    }
    // 选图时已经带了 mediaSubtypes 且非详情页全量查：直接判断，省一次原生调用
    if (!full && Array.isArray(normalized.mediaSubtypes)) {
      const live = isIosLiveSubtype(normalized.mediaSubtypes);
      const out = { live, source: 'ios', scanned: true };
      infoCache.set(baseKey, out);
      schedulePersist();
      return out;
    }
    let out = { live: false, source: 'ios', scanned: true };
    let pairedVideoUri = null;
    try {
      // 网格徽标不触发 iCloud 下载；详情页允许联网拉取配对视频
      const info = await MediaLibrary.getAssetInfoAsync(assetId, { shouldDownloadFromNetwork: !!full });
      if (isIosLiveSubtype(info?.mediaSubtypes)) {
        pairedVideoUri = info.pairedVideoAsset?.localUri || info.pairedVideoAsset?.uri || null;
        if (pairedVideoUri) iosPairedVideoCache.set(baseKey, pairedVideoUri);
        out = { live: true, source: 'ios', scanned: true };
      }
    } catch (e) {
      console.warn('[livePhoto] iOS 检测失败', e?.message || e);
    }
    infoCache.set(baseKey, out);
    schedulePersist();
    return pairedVideoUri ? { ...out, pairedVideoUri } : out;
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
        // ④ 尾部窗口兜底扫描（仅详情页）：只读文件尾那一段，跟整张图多大无关，
        //    所以不再限制文件大小（以前限制 40MB 是为了别整文件读）
        if (!out.live && full) {
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

/* 本次会话里已经提取好的动效地址：命中就直接返回，连 stat 都不做——
   "同一张照片点第二次不用等"就靠它；进后台清空目录时由上层一起清掉。 */
const readyCache = new Map();
// 正在提取的（预热和用户点击可能同时发生，共用同一个任务，别重复读两遍）
const pendingCache = new Map();

export const clearMotionVideoCache = () => {
  readyCache.clear();
  pendingCache.clear();
  iosPairedVideoCache.clear();
};

// 把窗口里的那一段 mp4 写出去（末尾按 box 结构裁到最后一个完整 box）
const writeMotionClip = async (win, startInWin, dest) => {
  const cleanEnd = mp4CleanEnd(win.bytes, startInWin);
  const end = cleanEnd > startInWin ? cleanEnd : win.bytes.length;
  const dir = `${FileSystem.documentDirectory}motionVideos`;
  if (!(await FileSystem.getInfoAsync(dir)).exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  new FileSystemNew.File(dest).write(win.bytes.subarray(startInWin, end));
};

// 提取内嵌的动态视频，返回可播放的本地 mp4 地址；解析失败返回 null（界面回退为静帧展示）。
// 只读尾部窗口 → 定位 mp4 起点 → 原地裁剪写出，全程不整文件读；磁盘 + 内存两层缓存
export const extractMotionVideo = async (entry, info) => {
  const normalized = normalizeEntry(entry) || {};
  const uri = normalized.uri;
  const key = normalized.assetId || uri;
  if (!key) return null;

  // iOS Live Photo：相册配对视频写在系统 tmp 目录，可能被系统清理；
  // 先校验现有路径是否还活着，不在的话重新向相册请求一次（支持从 iCloud 拉取）
  if (Platform.OS === 'ios') {
    const candidate = info?.pairedVideoUri || iosPairedVideoCache.get(key) || null;
    if (candidate) {
      try {
        if ((await FileSystem.getInfoAsync(candidate)).exists) return candidate;
      } catch {}
      iosPairedVideoCache.delete(key);
    }
    if (normalized.assetId) {
      try {
        const freshInfo = await MediaLibrary.getAssetInfoAsync(normalized.assetId, { shouldDownloadFromNetwork: true });
        const freshUri = freshInfo?.pairedVideoAsset?.localUri || freshInfo?.pairedVideoAsset?.uri || null;
        if (freshUri) {
          iosPairedVideoCache.set(key, freshUri);
          setLivePhotoError(null);
          return freshUri;
        }
      } catch (e) {
        console.warn('[livePhoto] iOS 获取配对视频失败', e?.message || e);
        setLivePhotoError(`iOS 获取配对视频失败：${e?.message || e}`);
      }
      if (!uri || !uri.startsWith('file://')) return null;
    }
  } else if (info?.pairedVideoUri) {
    return info.pairedVideoUri;
  }

  if (!uri || !uri.startsWith('file://')) return null;

  if (readyCache.has(key)) return readyCache.get(key);
  const inflight = pendingCache.get(key);
  if (inflight) return inflight;

  const dest = `${FileSystem.documentDirectory}motionVideos/${hashKey(key)}.mp4`;
  const task = (async () => {
    try {
      const existing = await FileSystem.getInfoAsync(dest);
      if (existing.exists) {
        readyCache.set(key, dest);
        return dest;
      }
    } catch {}

    // 视频长度已知就按它定窗口（+64KB 余量：有的厂商会在视频后再拼私有尾数据），
    // 不知道就从 2MB 起步、找不到再翻倍
    let want = info?.videoLength > 0 ? info.videoLength + 64 * 1024 : TAIL_STEP;
    for (;;) {
      const win = await readTailWindow(uri, Math.min(want, TAIL_CAP));
      if (!win) return null;
      const start = findMotionStart(win, info?.videoLength);
      if (start > 0) {
        await writeMotionClip(win, start, dest);
        readyCache.set(key, dest);
        setLivePhotoError(null);
        return dest;
      }
      // 窗口已经覆盖到文件头、或到了上限还没找到：这张不是实况 / 格式不认识
      if (win.windowStart === 0 || want >= TAIL_CAP) {
        setLivePhotoError('读到了文件但没找到内嵌 mp4（这张可能不是实况照片）');
        return null;
      }
      want = Math.min(want * 2, TAIL_CAP);
    }
  })();

  pendingCache.set(key, task);
  try {
    return await task;
  } catch (e) {
    console.warn('[livePhoto] 提取动态视频失败', e?.message || e);
    setLivePhotoError(`提取失败：${e?.message || e}`);
    return null;
  } finally {
    pendingCache.delete(key);
  }
};
