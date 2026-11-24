// 媒体引用解析：记录里只保存相册资产的引用（assetId）+ 一个备用 URI，
// 显示时通过 expo-media-library 把 assetId 实时解析成相册里的原始文件路径，
// 这样 App 内不会长期持有照片/视频的副本。
import * as MediaLibrary from 'expo-media-library';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import * as RN from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { COVERS_DIR, MEDIA_DIR, copyFileAsync, ensureDirAsync, deletePathAsync, rebaseAppFileUri, clearTempFilesAsync } from './storagePaths';

const RNImage = RN.Image;
const isIOS = () => RN.Platform?.OS === 'ios';
const thumbsNative = requireOptionalNativeModule('Thumbs');

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
let galleryAccessPromise = null;

// 权限查询只做一次：详情页一次要解析几十张相册引用，如果每个 asset 都去
// getPermissionsAsync / requestPermissionsAsync，主线程和原生桥都会被排队压住。
const ensureGalleryAccess = async () => {
  if (permissionDenied) return false;
  if (!galleryAccessPromise) {
    galleryAccessPromise = (async () => {
      let perm = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
      if (!hasGalleryAccess(perm)) {
        perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
      }
      if (!hasGalleryAccess(perm)) {
        permissionDenied = true;
        return false;
      }
      return true;
    })().catch(() => false);
  }
  return galleryAccessPromise;
};

// 相册资产解析并发上限：一次详情页几十个 assetId，不能让原生相册查询全部同时涌进来
const ASSET_INFO_CONCURRENCY = 4;
let assetInfoActive = 0;
const assetInfoQueue = [];
const pumpAssetInfo = () => {
  while (assetInfoActive < ASSET_INFO_CONCURRENCY && assetInfoQueue.length) {
    const job = assetInfoQueue.shift();
    assetInfoActive += 1;
    job.task()
      .then(job.resolve, job.reject)
      .finally(() => {
        assetInfoActive -= 1;
        pumpAssetInfo();
      });
  }
};
const queryAssetInfo = (assetId) => new Promise((resolve, reject) => {
  assetInfoQueue.push({ task: () => MediaLibrary.getAssetInfoAsync(assetId), resolve, reject });
  pumpAssetInfo();
});

// expo-media-library 在"仅允许访问部分照片"时 granted 为 false 但 accessPrivileges 是 limited，
// 这种状态下已选中的照片仍能正常查询，当作有权限处理，避免显示端一直回退到死路径
export const hasGalleryAccess = (perm) => !!perm && (perm.granted || perm.accessPrivileges === 'limited');

export const resolveMediaUri = async (entry) => {
  const { uri: rawUri, assetId } = normalizeMediaEntry(entry) || {};
  const uri = rebaseAppFileUri(rawUri);
  if (!assetId) return uri;
  // iOS 上 expo-image 原生直读 ph://（走 PhotoKit 按视口尺寸硬件解码，零拷贝），
  // 绝不能对每张图调用 getAssetInfoAsync（会整图解码 HEIC 并导出实况 .mov，极度卡顿）
  if (isIOS()) return `ph://${assetId}`;
  if (resolvedCache.has(assetId)) return resolvedCache.get(assetId);

  // 用户拒绝过权限就不反复弹窗，直接用备用 URI
  if (permissionDenied) return uri;
  try {
    // 只申请照片和视频权限；默认请求会带上 AUDIO，部分环境的 AndroidManifest 未声明会直接抛错
    if (!(await ensureGalleryAccess())) return uri;
    const info = await queryAssetInfo(assetId);
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
// 视频实际播放地址（按需在用户点开视频时调用）：
// iOS 上 expo-av 的 AVURLAsset 受沙盒限制无法直接播放 /var/mobile/Media/DCIM/，
// 必须通过原生 PhotoKit 将视频写入应用 tmp/playableVideos/ 后再交给播放器。
const playableVideoCache = new Map();
export const resolvePlayableVideoUri = async (entry) => {
  const { uri: rawUri, assetId } = normalizeMediaEntry(entry) || {};
  const uri = rebaseAppFileUri(rawUri);
  if (!isIOS()) return resolveMediaUri(entry);
  if (!assetId) return uri;

  const cached = playableVideoCache.get(assetId);
  if (cached) {
    try {
      if ((await FileSystem.getInfoAsync(cached)).exists) return cached;
    } catch {}
    playableVideoCache.delete(assetId);
  }
  if (thumbsNative?.getPlayableVideoUriAsync) {
    try {
      const playable = await thumbsNative.getPlayableVideoUriAsync(String(assetId));
      if (playable) {
        playableVideoCache.set(assetId, playable);
        return playable;
      }
    } catch (e) {
      console.warn('[video] 原生导出可播放视频失败', assetId, e?.message || e);
    }
  }
  try {
    if (await ensureGalleryAccess()) {
      const info = await queryAssetInfo(assetId);
      if (info?.localUri) return info.localUri;
    }
  } catch {}
  return uri;
};
const thumbCache = new Map();

// 简易字符串哈希：给磁盘缓存的封面帧文件命名用
const hashKey = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + '_' + s.length.toString(36);
};

const thumbJobs = new Map();
const THUMB_CONCURRENCY = 2;
let thumbActive = 0;
const thumbQueue = [];
const pumpThumbs = () => {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive += 1;
    job.task()
      .then(job.resolve, job.reject)
      .finally(() => {
        thumbActive -= 1;
        pumpThumbs();
      });
  }
};

// 真正解码视频帧的部分：只允许 2 个同时跑。一次详情页可能挂着十几段视频，
// 全部同时 getThumbnailAsync 会把解码器占满，返回按钮都要等它们结束。
const generateVideoThumbnail = async (uri, cacheKey, assetId = null) => {
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
    // iOS 相册视频：expo-video-thumbnails 无法读取 ph://，且会因沙盒校验拒绝 DCIM 路径。
    // 优先走 PhotoKit 原生 Thumbs 出帧（支持本地与 iCloud 视频），再落盘到 videoThumbs。
    if (isIOS() && assetId && thumbsNative?.getThumbnailAsync) {
      try {
        const res = await thumbsNative.getThumbnailAsync(String(assetId), true, 512);
        if (res?.uri) {
          try {
            const dir = `${FileSystem.documentDirectory}videoThumbs`;
            if (!(await FileSystem.getInfoAsync(dir)).exists) {
              await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
            }
            const dest = `${dir}/${hashKey(cacheKey)}.jpg`;
            await copyFileAsync(res.uri, dest);
            thumbCache.set(cacheKey, dest);
            return dest;
          } catch {
            thumbCache.set(cacheKey, res.uri);
            return res.uri;
          }
        }
      } catch {}
    }
    let sourceUri = uri;
    if (sourceUri?.startsWith('ph://') && assetId) {
      sourceUri = await resolveMediaUri({ uri: sourceUri, assetId });
    }
    if (!sourceUri || sourceUri.startsWith('ph://')) {
      thumbCache.set(cacheKey, null);
      return null;
    }
    const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(sourceUri, { time: 1000, quality: 0.3 });
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

export const getVideoThumbnail = (entry) => {
  const { uri: rawUri, assetId } = normalizeMediaEntry(entry) || {};
  const uri = rebaseAppFileUri(rawUri);
  if (!uri && !assetId) return Promise.resolve(null);
  const cacheKey = assetId || uri;
  if (thumbCache.has(cacheKey)) return Promise.resolve(thumbCache.get(cacheKey));
  if (thumbJobs.has(cacheKey)) return thumbJobs.get(cacheKey);

  const job = new Promise((resolve, reject) => {
    thumbQueue.push({
      task: () => generateVideoThumbnail(uri, cacheKey, assetId),
      resolve,
      reject,
    });
    pumpThumbs();
  }).finally(() => {
    thumbJobs.delete(cacheKey);
  });
  thumbJobs.set(cacheKey, job);
  return job;
};

// 详情页方格用的持久视频封面：宽 360、JPEG 0.7。
// 记录里只存文件路径，备份导出时再转 base64，避免 AsyncStorage 被图片撑爆。
export const getVideoPoster = async (entry) => {
  if (entry?.videoPoster?.uri || entry?.videoPoster?.base64) return entry.videoPoster;
  const thumbUri = await getVideoThumbnail(entry);
  if (!thumbUri) return null;
  const cacheKey = normalizeMediaEntry(entry)?.assetId || normalizeMediaEntry(entry)?.uri || thumbUri;
  const dir = `${FileSystem.documentDirectory}videoPosters`;
  const dest = `${dir}/poster_${hashKey(cacheKey)}_v2.jpg`;
  try {
    await ensureDirAsync(dir);
    const existing = await FileSystem.getInfoAsync(dest);
    if (existing.exists) {
      return { uri: dest, mime: 'image/jpeg', timeMs: 1000 };
    }
    const dims = await new Promise((resolve) => {
      RNImage.getSize(thumbUri, (w, h) => resolve(w && h ? { w, h } : null), () => resolve(null));
    });
    const width = 360;
    const height = dims ? Math.max(1, Math.round((dims.h * width) / dims.w)) : 360;
    const rendered = await ImageManipulator.manipulate(thumbUri)
      .resize({ width, height })
      .renderAsync();
    const saved = await rendered.saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
    await copyFileAsync(saved.uri, dest);
    try { await FileSystem.deleteAsync(saved.uri, { idempotent: true }); } catch {}
    return { uri: dest, mime: 'image/jpeg', width, height, timeMs: 1000 };
  } catch {
    return null;
  }
};

// 兼容旧调用：需要字节内容时再从持久文件读 base64（主要用于备份）。
export const getVideoPosterBase64 = async (entry) => {
  const poster = await getVideoPoster(entry);
  if (!poster) return null;
  if (poster.base64) return poster;
  if (!poster.uri?.startsWith('file://')) return { ...poster, base64: null };
  try {
    return {
      ...poster,
      base64: await FileSystem.readAsStringAsync(poster.uri, {
        encoding: FileSystem.EncodingType.Base64,
      }),
    };
  } catch {
    return { ...poster, base64: null };
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
// 详情页已改为紧凑小封面，统一复用 360px 缩略图，不再另存高清大图


const ensureCoversDir = async () => {
  await ensureDirAsync(COVERS_DIR);
  return COVERS_DIR;
};

// 把封面文件缩到长边 360px 并存进 covers 目录，返回新路径。
// 长边 ≤ 720px（2 倍目标）的视为已是小图，原样挪进 covers 目录；
// 探测/缩放失败返回 null（调用方回退原路径）
// nameKey：封面文件的命名依据（网络海报传原始 URL、自选封面传相册原片路径）。
// 不传就用 uri 本身。同一个来源永远落到同一个文件名——重复保存同一张封面只会覆盖，
// 不会像以前那样（时间戳+随机数）越存越多、留下同一张图的多个副本。
export const downscaleCover = async (rawUri, maxEdge = COVER_MAX_EDGE, nameKey = null) => {
  const uri = rebaseAppFileUri(rawUri);
  if (!uri) return null;
  const isPh = uri.startsWith('ph://');
  try {
    // 已经在 covers 目录里的小图：直接原样返回，避免每次启动迁移都复制出重复文件
    const dir = await ensureCoversDir();
    if (uri.startsWith(dir + '/')) return uri;
    if (!isPh) {
      const stat = await FileSystem.getInfoAsync(uri);
      if (!stat.exists) return null;
    }

    const dest0 = `${dir}/cover_${hashKey(nameKey || uri)}`;
    // 已经存过这一张（上一次保存/回填留下的）：直接用现成的，省一次缩放和复制
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      if ((await FileSystem.getInfoAsync(`${dest0}.${ext}`).catch(() => ({ exists: false }))).exists) {
        return `${dest0}.${ext}`;
      }
    }
    const dims = await new Promise((resolve) => {
      if (isPh) resolve(null); else RNImage.getSize(uri, (w, h) => resolve(w && h ? { w, h } : null), () => resolve(null));
    });
    let workUri = uri;
    if (isPh) {
      const assetId = uri.slice('ph://'.length);
      let produced = null;
      if (thumbsNative?.getThumbnailAsync) {
        try {
          const r = await thumbsNative.getThumbnailAsync(assetId, false, Math.min(1024, Math.max(maxEdge, 360)));
          if (r?.uri) produced = r.uri;
        } catch {}
      }
      if (!produced) {
        const rendered = await ImageManipulator.manipulate(uri)
          .resize({ width: maxEdge })
          .renderAsync();
        const saved = await rendered.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
        produced = saved.uri;
      }
      workUri = produced;
    }
    if (dims && !isPh) {
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
    const dest = `${dest0}.${ext}`;
    await copyFileAsync(workUri, dest);
    if (workUri !== uri && !workUri.includes('/thumbs/')) {
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
    const small = await downscaleCover(downloaded, COVER_MAX_EDGE, url);
    if (small) {
      try { await FileSystem.deleteAsync(downloaded, { idempotent: true }); } catch {}
      return small;
    }
    // 缩图失败：原图挪进 covers 目录兜底
    const moved = await downscaleCover(downloaded, 100000, url);
    return moved || downloaded;
  } catch {
    return url;
  }
};

// 新记录同时留两份：coverUrl 给详情 Hero（高分辨率），coverThumbUrl 给列表（小图）。
// 只下载一次，避免为了两张不同尺寸反复走网络。
export const downloadRemoteCoverVariants = async (url) => {
  if (!url || !url.startsWith('http')) {
    return { coverUrl: url || null, coverThumbUrl: url || null };
  }
  try {
    const tmp = `${FileSystem.cacheDirectory}cover_dl_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const { uri: downloaded } = await FileSystem.downloadAsync(url, tmp, { headers: DOWNLOAD_HEADERS });
    const thumb = await downscaleCover(downloaded, COVER_MAX_EDGE, url);
    const large = thumb;
    try { await FileSystem.deleteAsync(downloaded, { idempotent: true }); } catch {}
    return {
      coverUrl: large || url,
      coverThumbUrl: thumb || large || url,
    };
  } catch {
    return { coverUrl: url, coverThumbUrl: url };
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

// 实况提取出来的动效视频：只是"这次会话的临时文件"，进后台 / 下次启动就整体清空
// （见 LogContext 的 AppState 监听与启动清理）。所以它没有体积上限——留着才占地方，
// 清了下次看再提取一遍就是了。
export const clearMotionVideos = async () => {
  const dir = `${FileSystem.documentDirectory}motionVideos`;
  let freed = 0;
  try {
    freed = await dirSizeAsync(dir);
    if (freed > 0) await deletePathAsync(dir);
  } catch {}
  return freed;
};

// 可再生缓存的总闸：封面帧超过上限就整体清掉，下次用时自动重建。
// 启动时调用，防止长期使用后缓存无限膨胀
// （实况提取的 motionVideos 不在这里管：它进后台就整体清空，不需要上限）
export const enforceCacheCaps = async ({ thumbCapMB = 30 } = {}) => {
  try {
    const tDir = `${FileSystem.documentDirectory}videoThumbs`;
    if ((await dirSizeAsync(tDir)) > thumbCapMB * 1024 * 1024) {
      await deletePathAsync(tDir);
    }
  } catch {}
};

/* 手动清理可再生缓存。侧边栏「清理缓存」现在是二级选项，能挑清哪些：
   thumbs 封面帧（视频缩略图 + 选图器临时缩略图）、motion 实况提取的动效、
   images 图片浏览缓存（expo-image 磁盘缓存）、covers 没人引用的封面小图。
   返回 { freed, covers }：释放的字节数 + 清掉的孤儿封面张数。 */
export const cleanupMediaCaches = async (logs = [], { thumbs = true, motion = true, images = true, covers = true } = {}) => {
  let freed = 0;
  const dirs = [];
  if (thumbs) {
    dirs.push(
      `${FileSystem.documentDirectory}videoThumbs`,
      `${FileSystem.cacheDirectory}VideoThumbnails`,
      `${FileSystem.cacheDirectory}thumbs`,
      `${FileSystem.cacheDirectory}backups`
    );
  }
  if (motion) {
    dirs.push(`${FileSystem.documentDirectory}motionVideos`);
    if (isIOS()) freed += await clearTempFilesAsync();
  }
  for (const dir of dirs) {
    try {
      freed += await dirSizeAsync(dir);
      await deletePathAsync(dir);
    } catch {}
  }
  if (thumbs) thumbCache.clear();
  if (images) {
    try {
      await Image.clearDiskCache();
    } catch {}
  }
  // 封面小图不是"可再生"的，只删当前没有任何记录引用的那些（和「同步相册影像」共用同一套判定）
  let coversRemoved = 0;
  if (covers) {
    try {
      const r = await pruneOrphanCovers(logs);
      freed += r.freed;
      coversRemoved = r.removed;
    } catch {}
  }
  return { freed, covers: coversRemoved };
};

// 刚生成不到 5 分钟的副本一律不动：可能是添加页草稿里刚挑的、或刚分享进来还没保存的
const ORPHAN_MIN_AGE_MS = 5 * 60 * 1000;

/* media/ 目录有两个候选：
   ① 当前落点 MEDIA_DIR（原生 Paths 可用时是 Android/data/<包名>/files/media，否则内部 files/media）；
   ② 1.8.2 之前用的内部 documentDirectory/media。
   搬目录时老副本不会自己跟着走，只扫"当前"目录的话，旧目录里的残留就永远清不掉
   ——用户看到的"记录里没有、media 里还在"多半就是这一类。 */
const mediaDirsToScan = () => {
  const dirs = [MEDIA_DIR];
  const legacyInternal = `${FileSystem.documentDirectory}media`;
  if (legacyInternal !== MEDIA_DIR) dirs.push(legacyInternal);
  return dirs;
};

// 表单草稿里挂着的影像（添加/编辑页还没保存的那些）：同步清理孤儿副本时也要当成"被引用"，
// 否则"挑了照片还没保存、跑去同步相册"就会把草稿里的图删掉。页面每次改动/卸载时同步更新。
const draftMediaNames = new Set();
const collectMediaNames = (raw, into) => {
  const e = normalizeMediaEntry(raw);
  if (!e || typeof e !== 'object') return;
  for (const value of Object.values(e)) {
    if (typeof value !== 'string') continue;
    // content://media/external/images/media/<id> 里也带 "/media/"，但那是相册资产的
    // 数字 id，不是副本文件名；混进来只会把同名文件误判成"还有人用"。
    // 其余形态（file:// 路径、个别老数据里的裸路径）都照旧参与比对
    if (value.startsWith('content://')) continue;
    const clean = value.split('?')[0];
    if (!clean.includes('/media/')) continue;
    const name = clean.split('/').pop();
    if (name) into.add(name);
  }
};
export const setDraftMediaEntries = (entries = []) => {
  draftMediaNames.clear();
  for (const entry of entries) collectMediaNames(entry, draftMediaNames);
};

// 记录里所有指向 media/ 的文件名：判定副本"还有人用"的统一口径
// （记录字段都算，原片 / 实况视频 / 缩略图…，宁可多留也不误删）
export const referencedMediaNames = (logs = []) => {
  const names = new Set();
  for (const log of logs) {
    const entries = Array.isArray(log?.localImages) ? log.localImages : [];
    for (const raw of entries) collectMediaNames(raw, names);
  }
  return names;
};

// 一批媒体条目（重链后的形态）里仍指向 media/ 的文件名
export const entriesMediaNames = (entries = []) => {
  const names = new Set();
  for (const raw of entries) collectMediaNames(raw, names);
  return names;
};

// 文件路径的 basename（去掉 ? 查询串），用于按文件名比对
export const mediaNameOfUri = (uri) => String(uri || '').split('?')[0].split('/').pop();

// 删除失败的原因给大家看的一句人话：expo-file-system 那两句经典报错（只出现在
// Android/data 这类目录上）直接翻译成"系统拒绝了删除"，其余去掉路径、截断
const shortDeleteError = (raw) => {
  const s = String(raw || '');
  if (/isn't deletable|isn't writable/i.test(s)) return '系统拒绝了删除（App 私有外部目录的权限限制）';
  return s.replace(/Location '[^']*'/g, '文件').slice(0, 80) || '删除失败';
};

/* 副本目录里每个文件的"去向"分类。分类本身就是给用户看的答案：
   为什么点了同步还有文件留着？是还没人在用（马上删），还是真的有人还在用。
     referenced 记录里还挂着它（相册里找不到原片，删了记录就没图看）
     draft      还挂在「添加」页表单里没保存（草稿也算"在用"）
     fresh      刚导入不到 5 分钟（可能马上要保存，这次先不动）
     unreadable 连文件信息都读不到（权限 / 系统限制），不敢删
     orphan     没有任何引用 —— 同步时删掉的就是这一类 */
export const classifyMediaCopies = async (logs = []) => {
  const referenced = referencedMediaNames(logs);

  const referencedNames = [];
  const draftNames = [];
  const freshNames = [];
  const unreadable = [];
  const orphans = [];
  const errors = [];
  for (const dir of mediaDirsToScan()) {
    let names;
    try {
      names = await FileSystem.readDirectoryAsync(dir);
    } catch (e) {
      // 目录不存在是正常的（还没放过副本），只有"存在但读不了"才值得报出来
      try {
        const info = await FileSystem.getInfoAsync(dir);
        if (info.exists) errors.push(`${dir}: ${e?.message || e}`);
      } catch {}
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;   // .write-test 之类的探针不碰
      const path = `${dir}/${name}`;
      let info = null;
      let statError = null;
      try {
        info = await FileSystem.getInfoAsync(path);
      } catch (e) {
        statError = e?.message || String(e);
      }
      const item = {
        name,
        dir,
        path,
        size: typeof info?.size === 'number' ? info.size : 0,
        error: statError,
      };
      if (referenced.has(name)) { referencedNames.push(item); continue; }
      if (draftMediaNames.has(name)) { draftNames.push(item); continue; }
      if (statError) { unreadable.push(item); continue; }
      if (!info?.exists) continue;          // 已经不在了，不用管
      // modificationTime 单位是秒；读不到时间戳的平台直接跳过，宁可不删
      const mtime = typeof info.modificationTime === 'number' ? info.modificationTime * 1000 : 0;
      if (!mtime || Date.now() - mtime < ORPHAN_MIN_AGE_MS) { freshNames.push(item); continue; }
      orphans.push(item);
    }
  }
  const bytes = (list) => list.reduce((sum, it) => sum + (it.size || 0), 0);
  return {
    referenced: referencedNames,
    draft: draftNames,
    fresh: freshNames,
    unreadable,
    orphans,
    errors,
    total: referencedNames.length + draftNames.length + freshNames.length + unreadable.length + orphans.length,
    bytes: {
      referenced: bytes(referencedNames),
      draft: bytes(draftNames),
      fresh: bytes(freshNames),
      unreadable: bytes(unreadable),
      orphan: bytes(orphans),
      total: bytes(referencedNames) + bytes(draftNames) + bytes(freshNames) + bytes(unreadable) + bytes(orphans),
    },
  };
};

/* 清掉 media/ 里没有任何记录引用的影像副本（就是上面分类里的 orphan）。
   孤儿文件的来源：分享进来又放弃、保存失败、旧数据迁移残留、去重时被换掉的旧副本。
   记录一旦重链成相册原片就不该再留副本，留着既占空间、又会让人以为"这张还在记录里"。
   只扫 App 自己的那两个目录（当前落点 + 1.8.2 之前用的内部目录），相册和用户挑的
   公共目录一律不碰；判定"被引用"按**文件名**比对（记录里所有含 `/media/` 的字段 +
   表单草稿都算：原片 / 实况视频 / 缩略图…），宁可多留也不误删。
   返回删了几个、释放多少、扫过多少，以及**剩下的是哪几类**（界面据此说明"为什么还在"）。 */
export const pruneOrphanMediaCopies = async (logs = []) => {
  const c = await classifyMediaCopies(logs);
  let removed = 0;
  let freed = 0;
  const deleteReasons = [];
  for (const f of c.orphans) {
    const res = await deletePathAsync(f.path);
    if (res.ok) {
      removed++;
      freed += f.size;
    } else {
      // 删不掉要说出原因（以前这里静默吞掉，才出现"数据目录说有可清理的、同步却说没有多余的"）。
      // 原因里带上完整路径会连文件名一起露出来，只留一句短的
      deleteReasons.push(shortDeleteError(res.error));
    }
  }
  const failedBytes = c.orphans.reduce((sum, f) => sum + (f.size || 0), 0) - freed;
  return {
    removed,
    freed,
    scanned: c.total,
    errors: c.errors,
    // 剩下来的都是"有人用"或"暂时不敢动"的，如实报给界面，别让用户以为删漏了
    kept: {
      referenced: c.referenced.length,
      draft: c.draft.length,
      fresh: c.fresh.length,
      unreadable: c.unreadable.length,
    },
    keptBytes: {
      referenced: c.bytes.referenced,
      draft: c.bytes.draft,
      fresh: c.bytes.fresh,
      unreadable: c.bytes.unreadable,
    },
    // 确实没有引用、但这次没删掉的（删除失败）：只报数量、大小和一句原因，不列文件名
    failedToDelete: {
      count: c.orphans.length - removed,
      bytes: failedBytes,
      reasons: [...new Set(deleteReasons)],
    },
  };
};

/* covers/ 里没有记录引用的封面小图：换封面、删记录、同一张图重复下载留下的孤儿。
   封面只被记录的 coverUrl / coverThumbUrl 引用（按文件名比对），
   刚生成不到 5 分钟的不动（可能正挂在表单里），只扫 App 自己的封面目录。
   dryRun=true 只统计不删（「数据目录」诊断用）。 */
export const pruneOrphanCovers = async (logs = [], { dryRun = false } = {}) => {
  const referenced = new Set();
  for (const log of logs || []) {
    for (const field of ['coverUrl', 'coverThumbUrl']) {
      const url = log?.[field];
      if (typeof url === 'string' && url.startsWith('file://')) {
        const name = mediaNameOfUri(url);
        if (name) referenced.add(name);
      }
    }
  }
  let removed = 0;
  let freed = 0;
  let scanned = 0;
  let orphans = 0;
  let failed = 0;
  let names;
  try {
    names = await FileSystem.readDirectoryAsync(COVERS_DIR);
  } catch {
    return { removed: 0, freed: 0, scanned: 0, orphans: 0, failed: 0, errors: [] };
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    scanned++;
    if (referenced.has(name)) continue;
    const path = `${COVERS_DIR}/${name}`;
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (!info?.exists) continue;
      const mtime = typeof info.modificationTime === 'number' ? info.modificationTime * 1000 : 0;
      if (!mtime || Date.now() - mtime < ORPHAN_MIN_AGE_MS) continue;
      orphans++;
      if (dryRun) continue;
      // 和影像副本一样：Android/data 里的文件只能用原生删除（见 deletePathAsync）
      const res = await deletePathAsync(path);
      if (res.ok) {
        removed++;
        if (typeof info.size === 'number') freed += info.size;
      } else {
        failed++;
      }
    } catch {}
  }
  return { removed, freed, scanned, orphans, failed, errors: [] };
};

// 「数据目录」里的副本明细：按"为什么留着"分开报，一眼能看出是不是真删漏了。
// 返回 { text, draft, orphan }：text 给弹窗显示，draft / orphan 给上层做按钮（比如"清空草稿"）
export const describeMediaCopiesAsync = async (logs = []) => {
  const c = await classifyMediaCopies(logs);
  const covers = await pruneOrphanCovers(logs, { dryRun: true });
  const mb = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`);
  const lines = [];
  if (c.total === 0) {
    lines.push('副本 media：空的');
  } else {
    lines.push(
      `副本 media：共 ${c.total} 个，${mb(c.bytes.total)} —— `
      + `记录引用 ${c.referenced.length} 个（${mb(c.bytes.referenced)}）、`
      + `添加页草稿 ${c.draft.length} 个（${mb(c.bytes.draft)}）、`
      + `刚导入不到 5 分钟 ${c.fresh.length} 个（${mb(c.bytes.fresh)}）、`
      + `读不到信息 ${c.unreadable.length} 个、`
      + `可清理 ${c.orphans.length} 个（${mb(c.bytes.orphan)}）`
    );
    // 只报数量与大小，不列文件名（用户不需要、也容易看成一堆陌生名字）
    if (c.unreadable.length) lines.push(`  · 有 ${c.unreadable.length} 个文件读不到信息（系统限制，没法判断大小、不会删）`);
    if (c.errors.length) lines.push(`  · 目录读失败：${c.errors.join('；')}`);
  }
  if (covers.scanned > 0) {
    lines.push(`封面小图 covers：共 ${covers.scanned} 张，其中 ${covers.orphans} 张没有记录引用（同步 / 清理缓存会清掉）`);
  }
  return { text: lines.join('\n'), draft: c.draft.length, orphan: c.orphans.length };
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
  !!rebaseAppFileUri(uri) && rebaseAppFileUri(uri).startsWith('file://') && rebaseAppFileUri(uri).startsWith(`${MEDIA_DIR}/`);
