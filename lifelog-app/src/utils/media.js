// 媒体引用解析：记录里只保存相册资产的引用（assetId）+ 一个备用 URI，
// 显示时通过 expo-media-library 把 assetId 实时解析成相册里的原始文件路径，
// 这样 App 内不会长期持有照片/视频的副本。
import * as MediaLibrary from 'expo-media-library';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import { Image as RNImage } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { COVERS_DIR, MEDIA_DIR, copyFileAsync, ensureDirAsync } from './storagePaths';

// 兼容两种历史数据形态：纯 URI 字符串（旧记录 / 网络图）和 { uri, assetId } 对象
export const normalizeMediaEntry = (entry) =>
  typeof entry === 'string' ? { uri: entry } : entry || null;

export const mediaUri = (entry) => normalizeMediaEntry(entry)?.uri;

// 一条影像条目的稳定"身份"：相册引用 > 文件名 + 大小 > 完整 uri。
// 用途是让界面按身份（而不是下标）记住顺序：拖动重排写回存储后，记录里的条目会换成
// 一批新对象，但身份不变——顺序就不会被应用第二遍，落位后也不会闪回旧排列。
// 注意：不带 assetId 的条目，解析前后 uri 完全相同（resolveMediaUri 直接返回原 uri），
// 带 assetId 的走 assetId，所以同一张影像在"记录里"和"解析后"算出的身份一致
export const mediaSignature = (raw) => {
  const e = normalizeMediaEntry(raw) || {};
  if (e.assetId) return `a:${e.assetId}`;
  if (e.filename) return `f:${e.filename}:${e.size || 0}`;
  return e.uri ? `u:${e.uri}` : null;
};

// 条目里的文件名（小写），跨"分享副本 / 相册引用"比较同一张影像时用
const entryFileName = (e) => String(e?.filename || e?.uri || '').split('/').pop().split('?')[0].toLowerCase();

/* 一组媒体条目的"同一张影像"索引。
   为什么必须两套口径一起看：记录里的条目多半是相册引用（只有 assetId），
   而分享进来的副本只有 文件名 + 大小——只比 assetId 或只比文件名，总有一边对不上，
   表现就是"已经记过的照片又被加了一遍"。
   判定顺序（任何一条成立即算同一张）：
     ① assetId 相同；
     ② 文件名 + 大小都相同；
     ③ 文件名相同，且有一边拿不到大小（宁可当同一张，也别重复挂两份）；
     ④ 完整 uri 相同。
   add() 用于把"这一批里已经收下的"也并进索引，重复分享的同一张也会被挡住。 */
export const makeMediaIndex = (entries = []) => {
  const ids = new Set();       // assetId
  const exact = new Set();     // 文件名 + 大小
  const loose = new Set();     // 没有大小的条目的文件名
  const names = new Set();     // 全部文件名
  const uris = new Set();

  const add = (raw) => {
    const e = normalizeMediaEntry(raw) || {};
    if (e.assetId) ids.add(e.assetId);
    const name = entryFileName(e);
    if (name) {
      names.add(name);
      if (e.size) exact.add(`${name}:${e.size}`);
      else loose.add(name);
    }
    if (e.uri) uris.add(e.uri);
  };

  const has = (raw) => {
    const e = normalizeMediaEntry(raw) || {};
    if (e.assetId && ids.has(e.assetId)) return true;
    const name = entryFileName(e);
    if (name && names.has(name)) {
      if (!e.size) return true;                       // 这边拿不到大小：只比文件名
      if (exact.has(`${name}:${e.size}`)) return true;
      if (loose.has(name)) return true;               // 那份没有大小，不冒险当两张
    }
    return !!e.uri && uris.has(e.uri);
  };

  (entries || []).forEach(add);
  return { has, add, count: () => names.size };
};

// 相册里存的是引用时，显示端把 assetId 解析成原始路径；解析不到才回退到条目自带的 uri。
// 条目里的备用 uri 可能是早已删除的缓存副本（死路径），所以解析失败时不缓存结果，下次再试。
const resolvedCache = new Map();

let permissionDenied = false;

// expo-media-library 在"仅允许访问部分照片"时 granted 为 false 但 accessPrivileges 是 limited，
// 这种状态下已选中的照片仍能正常查询，当作有权限处理，避免显示端一直回退到死路径
export const hasGalleryAccess = (perm) => !!perm && (perm.granted || perm.accessPrivileges === 'limited');

export const resolveMediaUri = async (entry) => {
  const { uri, assetId } = normalizeMediaEntry(entry) || {};
  if (!assetId) return uri;
  if (resolvedCache.has(assetId)) return resolvedCache.get(assetId);

  // 用户拒绝过权限就不反复弹窗，直接用备用 URI
  if (permissionDenied) return uri;
  try {
    // 只申请照片和视频权限；默认请求会带上 AUDIO，部分环境的 AndroidManifest 未声明会直接抛错
    let perm = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
    if (!hasGalleryAccess(perm)) {
      perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
      if (!hasGalleryAccess(perm)) {
        permissionDenied = true;
        return uri;
      }
    }
    const info = await MediaLibrary.getAssetInfoAsync(assetId);
    // 拿不到 localUri（如云端照片未下载到本机）时不缓存，等下次有机会再解析
    if (info?.localUri) {
      resolvedCache.set(assetId, info.localUri);
      return info.localUri;
    }
    return uri;
  } catch (e) {
    // 资产可能已被删除或平台不支持，回退到保存时的 URI
    console.warn('[media] 解析相册媒体失败，回退备用路径', assetId, e?.message || e);
    return uri;
  }
};

// assetId -> 封面帧 的内存缓存（视频九宫格缩略图用，避免挂载真实播放器）
const thumbCache = new Map();

// 简易字符串哈希：给磁盘缓存的封面帧文件命名用
const hashKey = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + '_' + s.length.toString(36);
};

export const getVideoThumbnail = async (entry) => {
  const { uri, assetId } = normalizeMediaEntry(entry) || {};
  if (!uri) return null;
  const cacheKey = assetId || uri;
  if (thumbCache.has(cacheKey)) return thumbCache.get(cacheKey);

  // 封面帧落盘缓存：生成要现场解码视频，很慢；落盘后重开 App 秒出
  try {
    const dir = `${FileSystem.documentDirectory}videoThumbs`;
    const dest = `${dir}/${hashKey(cacheKey)}.jpg`;
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists) {
      thumbCache.set(cacheKey, dest);
      return dest;
    }
  } catch {}

  try {
    // quality 压低：默认按视频原始分辨率出高质量 JPEG，4K 视频一张能到几 MB，
    // 封面帧只用于小格子展示，低质量足够且落盘体积小一个数量级
    const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(uri, { time: 1000, quality: 0.3 });
    try {
      const dir = `${FileSystem.documentDirectory}videoThumbs`;
      if (!(await FileSystem.getInfoAsync(dir)).exists) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      }
      const dest = `${dir}/${hashKey(cacheKey)}.jpg`;
      await FileSystem.copyAsync({ from: thumbUri, to: dest });
      thumbCache.set(cacheKey, dest);
      return dest;
    } catch {
      thumbCache.set(cacheKey, thumbUri);
      return thumbUri;
    }
  } catch {
    thumbCache.set(cacheKey, null);
    return null;
  }
};

// 判断是否视频：优先看记录时留下的类型标记，没有标记再按扩展名猜
export const isVideoEntry = (entry) => {
  const { isVideo: flagged, uri } = normalizeMediaEntry(entry) || {};
  if (flagged !== undefined) return !!flagged;
  if (!uri) return false;
  return uri.includes('video') || uri.split('?')[0].match(/\.(mp4|mov|m4v|3gp|avi)$/i) !== null;
};

// 豆瓣海报是竖版 2:3，用于没有宽高比信息时的封面显示
export const DOUBAN_POSTER_RATIO = 2 / 3;

// 封面落盘的长边上限：显示端只有 46~64pt（3 倍屏 ≈ 192px），360px 有充足冗余，
// 单张从 ~200KB 降到 ~25KB，备份体积同步受益
const COVER_MAX_EDGE = 360;

const ensureCoversDir = async () => {
  await ensureDirAsync(COVERS_DIR);
  return COVERS_DIR;
};

// 把封面文件缩到长边 360px 并存进 covers 目录，返回新路径。
// 长边 ≤ 720px（2 倍目标）的视为已是小图，原样挪进 covers 目录；
// 探测/缩放失败返回 null（调用方回退原路径）
export const downscaleCover = async (uri, maxEdge = COVER_MAX_EDGE) => {
  try {
    // 已经在 covers 目录里的小图：直接原样返回，避免每次启动迁移都复制出重复文件
    const dir = await ensureCoversDir();
    if (uri.startsWith(dir + '/')) return uri;
    const stat = await FileSystem.getInfoAsync(uri);
    if (!stat.exists) return null;
    const dims = await new Promise((resolve) => {
      RNImage.getSize(uri, (w, h) => resolve(w && h ? { w, h } : null), () => resolve(null));
    });
    let workUri = uri;
    if (dims) {
      const long = Math.max(dims.w, dims.h);
      if (long > maxEdge * 2) {
        const scale = maxEdge / long;
        const rendered = await ImageManipulator.manipulate(uri)
          .resize({ width: Math.round(dims.w * scale), height: Math.round(dims.h * scale) })
          .renderAsync();
        const saved = await rendered.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
        workUri = saved.uri;
      }
    }
    const ext = (workUri.split('?')[0].match(/\.(jpe?g|png|webp)$/i) || [])[1] || 'jpg';
    const dest = `${dir}/cover_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
    await copyFileAsync(workUri, dest);
    if (workUri !== uri) {
      try { await FileSystem.deleteAsync(workUri, { idempotent: true }); } catch {}
    }
    return dest;
  } catch {
    return null;
  }
};

// 把网络海报下载到本地持久目录，缩成小图后作为离线可用的封面；失败时返回原网络地址
// 豆瓣图床有防盗链：必须带浏览器 UA + Referer，否则一律 418 拒绝
const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://www.douban.com/',
};

export const downloadRemoteCover = async (url) => {
  if (!url || !url.startsWith('http')) return url || null;
  try {
    const tmp = `${FileSystem.cacheDirectory}cover_dl_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const { uri: downloaded } = await FileSystem.downloadAsync(url, tmp, { headers: DOWNLOAD_HEADERS });
    const small = await downscaleCover(downloaded, COVER_MAX_EDGE);
    if (small) {
      try { await FileSystem.deleteAsync(downloaded, { idempotent: true }); } catch {}
      return small;
    }
    // 缩图失败：原图挪进 covers 目录兜底
    const moved = await downscaleCover(downloaded, 100000);
    return moved || downloaded;
  } catch {
    return url;
  }
};

// 网络图直接显示时也要带防盗链头（旧记录里存的还是豆瓣热链）
export const remoteImageSource = (url) => {
  if (!url) return null;
  return url.includes('doubanio.com')
    ? { uri: url, headers: DOWNLOAD_HEADERS }
    : { uri: url };
};

// 统计一个目录的大小（字节）；目录不存在或出错返回 0
const dirSizeAsync = async (dir) => {
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return 0;
    const files = await FileSystem.readDirectoryAsync(dir);
    let total = 0;
    for (const f of files) {
      try {
        const fi = await FileSystem.getInfoAsync(`${dir}/${f}`);
        if (fi.exists && typeof fi.size === 'number') total += fi.size;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
};

// 可再生缓存的总闸：封面帧/实况提取缓存超过上限就整体清掉，下次用时自动重建。
// 启动时调用，防止长期使用后缓存无限膨胀
export const enforceCacheCaps = async ({ thumbCapMB = 30, motionCapMB = 50 } = {}) => {
  try {
    const tDir = `${FileSystem.documentDirectory}videoThumbs`;
    const mDir = `${FileSystem.documentDirectory}motionVideos`;
    if ((await dirSizeAsync(tDir)) > thumbCapMB * 1024 * 1024) {
      await FileSystem.deleteAsync(tDir, { idempotent: true });
    }
    if ((await dirSizeAsync(mDir)) > motionCapMB * 1024 * 1024) {
      await FileSystem.deleteAsync(mDir, { idempotent: true });
    }
  } catch {}
};

// 手动清理所有可再生缓存（封面帧、实况提取、选图器临时拷贝、图片浏览缓存），返回释放的字节数
export const cleanupMediaCaches = async () => {
  let freed = 0;
  const dirs = [
    `${FileSystem.documentDirectory}videoThumbs`,
    `${FileSystem.documentDirectory}motionVideos`,
    `${FileSystem.cacheDirectory}VideoThumbnails`,
  ];
  for (const dir of dirs) {
    try {
      freed += await dirSizeAsync(dir);
      await FileSystem.deleteAsync(dir, { idempotent: true });
    } catch {}
  }
  thumbCache.clear();
  try {
    await Image.clearDiskCache();
  } catch {}
  return freed;
};

// 启动时清理瞬时缓存：这些都是可再生的内容，清掉无损
// - VideoThumbnails：expo-video-thumbnails 的临时输出（正式封面帧在 videoThumbs/，不受影响）
// 注意：expo-image 的磁盘缓存【不在启动清理范围】——清掉会导致列表封面每次重启都重新加载，
// 它有系统级自动淘汰，需要手动释放时走侧边栏「清理缓存」
export const cleanTransientCaches = async () => {
  try {
    const dirs = [
      `${FileSystem.cacheDirectory}VideoThumbnails`,
    ];
    for (const dir of dirs) {
      const info = await FileSystem.getInfoAsync(dir);
      if (info.exists) await FileSystem.deleteAsync(dir, { idempotent: true });
    }
  } catch {
    // 清理失败不影响使用
  }
};

// 应用私有的媒体副本目录（MEDIA_DIR，默认内部存储、可用时是 Android/data）。
// 只有这里的文件在重链到相册原片后可以放心删掉——相册里的、用户自己的文件绝不动。
export const isAppOwnedMediaPath = (uri) =>
  !!uri && uri.startsWith('file://') && uri.startsWith(`${MEDIA_DIR}/`);
