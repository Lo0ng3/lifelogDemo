// 应用私有媒体的落点。默认在内部存储（/data/user/0/<包名>/files，没有 root 看不到），
// 原生模块 Paths 可用时改到应用专属外部目录
// （/storage/emulated/0/Android/data/<包名>/files），这样影像副本和封面能用手机
// 文件管理器直接翻到、手动拷走。
//
// 只搬 media 和 covers：这两样是用户可能想看的。videoThumbs / motionVideos 是纯缓存
// （有体积上限、删了自动重建），继续留在内部目录，不占 Android/data 的位置。
//
// 外部目录不可用（未挂载、iOS、同步调用失败）时不报错，静默回退内部目录。
import * as RN from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as FileSystem from 'expo-file-system/legacy';
import { getLivePhotoError } from './diag';

const isIOS = () => RN.Platform?.OS === 'ios';
const native = requireOptionalNativeModule('Paths');

const readExternalRoot = () => {
  // 只读属性、同步函数两种取法都试一遍（不同版本的 expo-modules-core 暴露方式略有差别）
  try {
    const dir = native?.externalFilesDir || native?.getExternalFilesDir?.();
    return dir ? `file://${dir}/` : null;
  } catch {
    return null;
  }
};

const externalFilesDir = readExternalRoot();

// 带 file:// 前缀、以 / 结尾
export const STORAGE_ROOT = externalFilesDir || FileSystem.documentDirectory;
// 是否真的落在 Android/data 下（排查用）
export const IS_EXTERNAL_STORAGE = !!externalFilesDir;

// 分享进来的副本 / 旧数据迁移副本（重链回相册原片后会被删掉）
export const MEDIA_DIR = `${STORAGE_ROOT}media`;
// 封面小图（网络海报、自选封面）
export const COVERS_DIR = `${STORAGE_ROOT}covers`;

// iOS 每次更新/重装应用时，沙盒容器的 UUID 都会变化（/Containers/Data/Application/<UUID>/Documents/）。
// 把持久化在 AsyncStorage 里的绝对 file:// 路径重新锚定到当前 documentDirectory，
// 防止升级后封面、头像、视频封面和本地副本全部断链。
const APP_DOC_SUBDIR_RE = /\/Documents\/((?:covers|media|videoPosters|videoThumbs|motionVideos|profile|internal-backup)\/.+)$/;
export const rebaseAppFileUri = (uri) => {
  if (typeof uri !== 'string' || !uri.startsWith('file://') || !FileSystem.documentDirectory) return uri;
  if (uri.startsWith(FileSystem.documentDirectory) || uri.startsWith(STORAGE_ROOT)) return uri;
  const match = uri.match(APP_DOC_SUBDIR_RE);
  if (!match) return uri;
  return `${FileSystem.documentDirectory}${match[1]}`;
};

export const rebaseLogFileUris = (log) => {
  if (!log || typeof log !== 'object') return log;
  let changed = false;
  const next = { ...log };
  for (const field of ['coverUrl', 'coverThumbUrl']) {
    if (typeof next[field] === 'string') {
      const rebased = rebaseAppFileUri(next[field]);
      if (rebased !== next[field]) {
        next[field] = rebased;
        changed = true;
      }
    }
  }
  if (Array.isArray(next.localImages) && next.localImages.length) {
    let imgsChanged = false;
    const nextImages = next.localImages.map((raw) => {
      if (typeof raw === 'string') {
        const r = rebaseAppFileUri(raw);
        if (r !== raw) { imgsChanged = true; return r; }
        return raw;
      }
      if (!raw || typeof raw !== 'object') return raw;
      let entryChanged = false;
      const e = { ...raw };
      if (typeof e.uri === 'string') {
        const r = rebaseAppFileUri(e.uri);
        if (r !== e.uri) { e.uri = r; entryChanged = true; }
      }
      if (e.videoPoster && typeof e.videoPoster.uri === 'string') {
        const r = rebaseAppFileUri(e.videoPoster.uri);
        if (r !== e.videoPoster.uri) {
          e.videoPoster = { ...e.videoPoster, uri: r };
          entryChanged = true;
        }
      }
      if (entryChanged) imgsChanged = true;
      return entryChanged ? e : raw;
    });
    if (imgsChanged) {
      next.localImages = nextImages;
      changed = true;
    }
  }
  return changed ? next : log;
};

// 读取文件大小（原生优先：绕过 expo-file-system 对 iOS App Group / DCIM 等沙盒外路径的限制）
export const getFileSizeAsync = async (uri) => {
  if (!uri) return null;
  if (native?.getFileSize) {
    try {
      const size = await native.getFileSize(uri);
      if (typeof size === 'number' && size >= 0) return size;
    } catch {}
  }
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info?.exists && typeof info.size === 'number') return info.size;
  } catch {}
  return null;
};

// iOS 清理 WKWebView 缓存（react-native-webview 的 clearCache 仅支持 Android）
export const clearWebKitCacheAsync = async () => {
  if (!native?.clearWebKitCache) return false;
  try {
    return !!(await native.clearWebKitCache());
  } catch {
    return false;
  }
};

// iOS 清理 tmp/ 临时目录（早期实况/视频导出临时文件等），返回释放的字节数
export const clearTempFilesAsync = async () => {
  if (!native?.clearTempFiles) return 0;
  try {
    const freed = await native.clearTempFiles();
    return typeof freed === 'number' && freed > 0 ? freed : 0;
  } catch {
    return 0;
  }
};

// 按苹果系统标准（十进制 1000 换算）格式化体积，与 iOS「设置 → iPhone 储存空间」一致
export const formatStorageSize = (bytes) => {
  const b = Math.max(0, Number(bytes) || 0);
  if (b === 0) return '0 KB';
  if (b < 1000 * 1000) return `${Math.max(1, Math.round(b / 1000))} KB`;
  if (b < 1000 * 1000 * 1000) return `${(b / (1000 * 1000)).toFixed(1)} MB`;
  return `${(b / (1000 * 1000 * 1000)).toFixed(2)} GB`;
};

const SUB_BUCKET_NOTES = {
  media: '分享或导入、尚未关联相册原片的本地副本',
  covers: '列表与详情使用的封面小图',
  videoPosters: '视频静态封面图',
  videoThumbs: '视频列表预览帧，清理后可按需重建',
  internalBackup: '应用自动生成的本地 JSON 备份',
  profile: '个人头像与资料文件',
  asyncStorage: '所有文字印记、标签与地图配置',
  appSupport: '应用运行支持文件',
  documentsOther: '文档目录下的其他文件',
  imageDiskCache: '列表与看图磁盘缓存，清理后自动重建',
  thumbs: '相册选图器与视频缩略图缓存',
  imageManipulator: '图片裁剪与压缩临时产物',
  webKit: '地图瓦片、高德 SDK 与网页离线缓存',
  httpCache: '网络请求与地图瓦片 HTTP 缓存',
  tmp: '系统临时目录（实况/视频导出临时文件）',
  motionVideos: '实况照片动效临时提取文件',
  cacheBackups: '导出备份时生成的临时 JSON 文件',
  videoThumbnailsCache: '视频帧提取临时缓存',
  preferences: '系统与用户偏好设置文件',
  splashBoard: 'iOS 系统启动屏缓存快照',
  savedState: '应用界面状态恢复数据',
};

const groupOfBucket = (bucket) => {
  if (bucket === 'records' || bucket === 'covers' || bucket === 'media') return 'app';
  if (bucket === 'imageCache') return 'imageCache';
  if (bucket === 'mapCache') return 'mapCache';
  return 'other';
};

// 结构化全沙盒体积统计（供「存储与数据」弹窗使用）：
// - iOS：调用原生 Paths.getStorageBreakdown() 扫描整个 NSHomeDirectory()，按实际磁盘占用块统计，
//   所有分类相加严格等于系统「文稿与数据」总大小；同时返回二级子项与较大文件列表供点开查看；
// - Android：按目录统计并汇总，同样输出二级子项与较大文件列表。
export const getStorageSummaryAsync = async () => {
  if (isIOS() && native?.getStorageBreakdown) {
    try {
      const raw = await native.getStorageBreakdown();
      const b = raw?.buckets || {};
      const pick = (k) => ({
        bytes: Number(b[k]?.bytes) || 0,
        files: Number(b[k]?.files) || 0,
      });
      const items = [
        { key: 'records', label: '记录、备份与头像', note: '文字记录、本地自动备份与个人头像', ...pick('records') },
        { key: 'covers', label: '封面与视频预览帧', note: '列表/详情封面小图与视频封面帧', ...pick('covers') },
        { key: 'media', label: '本地媒体副本', note: '分享或导入尚未关联原片的副本', ...pick('media') },
        { key: 'imageCache', label: '图片与缩略图缓存', note: '看图缓存，清理后可自动重建', ...pick('imageCache') },
        { key: 'mapCache', label: '地图与网页缓存', note: '地图瓦片、SDK 与网络缓存', ...pick('mapCache') },
        { key: 'temp', label: '临时文件', note: '实况/导出产生的临时文件，可随时清理', ...pick('temp') },
        { key: 'system', label: '系统与其它', note: '偏好设置、启动快照等系统开销', ...pick('system') },
      ];
      const rawSubs = raw?.subBuckets && typeof raw.subBuckets === 'object' ? raw.subBuckets : null;
      const subItems = rawSubs
        ? Object.entries(rawSubs)
            .map(([key, v]) => ({
              key,
              bucket: v?.bucket || 'system',
              group: v?.group || groupOfBucket(v?.bucket),
              label: v?.label || key,
              note: SUB_BUCKET_NOTES[key] || '',
              bytes: Number(v?.bytes) || 0,
              files: Number(v?.files) || 0,
            }))
            .filter((s) => s.bytes > 0 || s.files > 0)
            .sort((a, b2) => b2.bytes - a.bytes)
        : items
            .filter((i) => i.bytes > 0 || i.files > 0)
            .map((i) => ({
              key: i.key,
              bucket: i.key,
              group: groupOfBucket(i.key),
              label: i.label,
              note: i.note,
              bytes: i.bytes,
              files: i.files,
            }));

      const rawTop = raw?.topFiles && typeof raw.topFiles === 'object' ? raw.topFiles : {};
      const topFiles = { app: [], imageCache: [], mapCache: [], other: [] };
      for (const gk of Object.keys(topFiles)) {
        const list = Array.isArray(rawTop[gk]) ? rawTop[gk] : [];
        topFiles[gk] = list.map((f) => ({
          name: String(f?.name || ''),
          relPath: String(f?.relPath || ''),
          bytes: Number(f?.bytes) || 0,
          bucket: String(f?.bucket || ''),
          subKey: String(f?.subKey || ''),
          subLabel: String(f?.subLabel || ''),
        }));
      }

      return {
        exact: true,
        totalBytes: Number(raw?.totalBytes) || items.reduce((s, i) => s + i.bytes, 0),
        totalFiles: Number(raw?.totalFiles) || items.reduce((s, i) => s + i.files, 0),
        locationNote: '应用文档目录（可在「文件」App → 我的 iPhone → 印记查看）',
        items,
        subItems,
        topFiles,
      };
    } catch {}
  }

  // Android / 兜底路径：按主要目录汇总，同时收集二级子项与较大文件
  const [stMedia, stCovers, stThumbs, stPosters, stMotion, stBackup, stProfile] = await Promise.all([
    dirStatsAsync(MEDIA_DIR, 2, 'Documents/media'),
    dirStatsAsync(COVERS_DIR, 2, 'Documents/covers'),
    dirStatsAsync(`${FileSystem.documentDirectory}videoThumbs`, 2, 'Documents/videoThumbs'),
    dirStatsAsync(`${FileSystem.documentDirectory}videoPosters`, 2, 'Documents/videoPosters'),
    dirStatsAsync(`${FileSystem.documentDirectory}motionVideos`, 2, 'Documents/motionVideos'),
    dirStatsAsync(`${FileSystem.documentDirectory}internal-backup`, 2, 'Documents/internal-backup'),
    dirStatsAsync(`${FileSystem.documentDirectory}profile`, 2, 'Documents/profile'),
  ]);

  const subItems = [];
  const topFiles = { app: [], imageCache: [], mapCache: [], other: [] };
  const addSub = (key, bucket, label, st) => {
    if (!st || (st.bytes <= 0 && st.files <= 0)) return;
    const group = groupOfBucket(bucket);
    subItems.push({
      key,
      bucket,
      group,
      label,
      note: SUB_BUCKET_NOTES[key] || '',
      bytes: st.bytes,
      files: st.files,
    });
    if (Array.isArray(st.topFiles)) {
      for (const f of st.topFiles) {
        topFiles[group].push({ ...f, bucket, subKey: key, subLabel: label });
      }
    }
  };

  addSub('media', 'media', '本地媒体副本', stMedia);
  addSub('covers', 'covers', '封面小图', stCovers);
  addSub('videoPosters', 'covers', '视频封面图', stPosters);
  addSub('videoThumbs', 'covers', '视频预览帧', stThumbs);
  addSub('internalBackup', 'records', '本地自动备份', stBackup);
  addSub('profile', 'records', '个人头像与资料', stProfile);
  addSub('motionVideos', 'temp', '实况动效临时文件', stMotion);

  let imageCacheBytes = 0;
  let imageCacheFiles = 0;
  let mapCacheBytes = 0;
  let mapCacheFiles = 0;
  let extraTempBytes = 0;
  let extraTempFiles = 0;
  try {
    const cacheRoot = FileSystem.cacheDirectory;
    const names = await FileSystem.readDirectoryAsync(cacheRoot);
    for (const name of names) {
      const st = await dirStatsAsync(`${cacheRoot}${name}`, 3, `cache/${name}`);
      if (st.bytes <= 0 && st.files <= 0) continue;
      if (name === 'WebView' || name === 'WebKit') {
        mapCacheBytes += st.bytes;
        mapCacheFiles += st.files;
        addSub('webKit', 'mapCache', '地图与网页缓存', st);
      } else if (name === 'backups' || name === 'VideoThumbnails') {
        extraTempBytes += st.bytes;
        extraTempFiles += st.files;
        addSub(name === 'backups' ? 'cacheBackups' : 'videoThumbnailsCache', 'temp', CACHE_DIR_LABELS[name] || name, st);
      } else {
        imageCacheBytes += st.bytes;
        imageCacheFiles += st.files;
        addSub(`cache:${name}`, 'imageCache', CACHE_DIR_LABELS[name] || `缓存 (${name})`, st);
      }
    }
  } catch {}

  subItems.sort((a, b2) => b2.bytes - a.bytes);
  for (const gk of Object.keys(topFiles)) {
    topFiles[gk] = topFiles[gk].sort((a, b2) => b2.bytes - a.bytes).slice(0, 20);
  }

  const items = [
    { key: 'records', label: '记录、备份与头像', note: '内部备份与个人头像', bytes: stBackup.bytes + stProfile.bytes, files: stBackup.files + stProfile.files },
    { key: 'covers', label: '封面与视频预览帧', note: '封面小图与视频封面帧', bytes: stCovers.bytes + stThumbs.bytes + stPosters.bytes, files: stCovers.files + stThumbs.files + stPosters.files },
    { key: 'media', label: '本地媒体副本', note: '未重链回相册的本地副本', bytes: stMedia.bytes, files: stMedia.files },
    { key: 'imageCache', label: '图片与缩略图缓存', note: '图片缓存目录，清理后可自动重建', bytes: imageCacheBytes, files: imageCacheFiles },
    { key: 'mapCache', label: '地图与网页缓存', note: 'WebView 瓦片与网络缓存', bytes: mapCacheBytes, files: mapCacheFiles },
    { key: 'temp', label: '临时文件', note: '实况动效与导出临时文件', bytes: stMotion.bytes + extraTempBytes, files: stMotion.files + extraTempFiles },
  ];
  const totalBytes = items.reduce((s, i) => s + i.bytes, 0);
  const totalFiles = items.reduce((s, i) => s + i.files, 0);
  return {
    exact: false,
    totalBytes,
    totalFiles,
    locationNote: IS_EXTERNAL_STORAGE ? '应用外部目录（Android/data，文件管理器可见）' : '应用内部存储',
    items,
    subItems,
    topFiles,
  };
};

/* ------------------------------------------------------------------ *
 * 写文件为什么绕到原生去
 *
 * expo-file-system（legacy 和新版 File/Directory 都一样）在动一个路径之前会先查
 * File.canWrite() / canRead()，而**还不存在**的文件和目录这两个判定都是 false，
 * 于是往 Android/data 这类沙盒外目录里"新建目录 / 复制一个新文件 / 写一个新文件"
 * 会被直接拒掉（报 "Location ... isn't writable"）。内部目录不受影响，是因为它按
 * 前缀直接放行（见 expo-modules-core 的 FilePermissionModule）。
 *
 * 所以外部目录的建目录 / 复制 / 写字节改走 Paths 原生模块（纯 java.io.File，路径
 * 只可能是我们自己拼的 App 私有目录）；拿不到原生模块（iOS、老构建）时退回
 * expo-file-system。读、删、stat 这些针对**已存在**文件的操作继续用
 * expo-file-system，不受影响。
 * ------------------------------------------------------------------ */

// 保证目录存在
export const ensureDirAsync = async (dir) => {
  if (native?.ensureDir) {
    try {
      if (await native.ensureDir(dir)) return;
    } catch {}
  }
  const info = await FileSystem.getInfoAsync(dir).catch(() => ({ exists: false }));
  if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
};

// 复制文件，目标还不存在也能建出来
export const copyFileAsync = async (from, to) => {
  if (native?.copyFile) {
    try {
      if (await native.copyFile(from, to)) return;
    } catch {}
  }
  await FileSystem.copyAsync({ from, to });
};

// 写入 base64 内容，目标还不存在也能建出来
export const writeFileBase64Async = async (dest, base64) => {
  if (native?.writeFileBase64) {
    try {
      if (await native.writeFileBase64(dest, base64)) return;
    } catch {}
  }
  await FileSystem.writeAsStringAsync(dest, base64, { encoding: FileSystem.EncodingType.Base64 });
};

/* 只读区间读（原生）。实况照片的动效贴在相册原片尾部，只需要读最后一段；
   但 expo-file-system 的 FileHandle 是用 `RandomAccessFile(file, "rw")` 打开的，
   相册里的照片 App 没有写权限 → 一 open 就 EACCES（"实况提取一直是 0 个文件"就是这个原因）。
   所以走原生 `Paths.readFileRange`（"r" 打开）。原生模块不在（iOS / 旧构建）时返回 null，
   调用方回退到整文件读。 */
export const readFileRangeAsync = async (uri, offset, length) => {
  if (!native?.readFileRange) return null;
  try {
    const bytes = await native.readFileRange(uri, offset, length);
    return bytes && bytes.length ? bytes : null;
  } catch (e) {
    console.warn('[storage] 区间读失败', uri, e?.message || e);
    return null;
  }
};

// 文件/目录在不在：优先看父目录的名字表（expo-file-system 对**不存在**的沙盒外路径
// getInfoAsync 会抛错，单靠它分不清"没有"和"读不到"），读不了目录再退回 getInfoAsync
const pathExistsAsync = async (path) => {
  const cut = path.lastIndexOf('/');
  const parent = path.slice(0, cut);
  const name = path.slice(cut + 1);
  try {
    const names = await FileSystem.readDirectoryAsync(parent);
    return names.includes(name);
  } catch {
    try {
      return !!(await FileSystem.getInfoAsync(path)).exists;
    } catch {
      return true;   // 拿不准就当还在（宁可不报"删掉了"）
    }
  }
};

/* 删除 App 私有目录里的文件 / 目录，返回 { ok, error }。
 *
 * 为什么不能只用 FileSystem.deleteAsync：它删之前会检查 `Uri.withAppendedPath(uri, "..")`
 * 的写权限（见 expo-file-system 的 legacy deleteAsync），而给一个**文件**路径拼上 ".."
 * 之后 File.canWrite() 的 stat 直接失败 —— 于是 Android/data 里的文件永远报
 * "Location ... isn't deletable."。用户看到的就是"同步说清理过了，文件还在"。
 * 所以这里优先走原生 Paths.deletePath（java.io.File.deleteRecursively），
 * 原生模块不在（iOS / 老构建）或失败时才退回 expo-file-system，最后按目录名字表复核。 */
export const deletePathAsync = async (path) => {
  let error = null;
  if (native?.deletePath) {
    try {
      const done = await native.deletePath(path);
      if (done && !(await pathExistsAsync(path))) return { ok: true, error: null };
      if (!done) error = '原生删除返回失败';
    } catch (e) {
      error = e?.message || String(e);
    }
  }
  try {
    await FileSystem.deleteAsync(path, { idempotent: true });
  } catch (e) {
    error = error || e?.message || String(e);
  }
  if (!(await pathExistsAsync(path))) return { ok: true, error: null };
  return { ok: false, error: error || '文件还在（删除没有生效）' };
};

// 目录体积：递归统计文件数与字节数。目录不存在/读不了都返回 0，不抛错。
// expo-file-system 的 getInfoAsync 对**不存在**的沙盒外路径会先抛权限错，
// 所以每一层都要自己吞异常；maxEntries 兜底，避免缓存目录里几万个文件把诊断卡住
const MAX_SCAN_ENTRIES = 4000;
const dirStatsAsync = async (dir, depth = 3, relPrefix = '') => {
  let files = 0;
  let bytes = 0;
  let scanned = 0;
  const topFiles = relPrefix ? [] : null;
  const walk = async (d, left, relBase) => {
    if (scanned >= MAX_SCAN_ENTRIES) return;
    let names;
    try {
      names = await FileSystem.readDirectoryAsync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (scanned >= MAX_SCAN_ENTRIES) return;
      scanned++;
      const p = `${d}/${n}`;
      const rel = relBase ? `${relBase}/${n}` : n;
      try {
        const info = await FileSystem.getInfoAsync(p);
        if (!info.exists) continue;
        if (info.isDirectory) {
          if (left > 0) await walk(p, left - 1, rel);
          continue;
        }
        files++;
        if (typeof info.size === 'number') {
          bytes += info.size;
          if (topFiles && info.size > 0) {
            topFiles.push({ name: n, relPath: rel, bytes: info.size });
            if (topFiles.length > 60) {
              topFiles.sort((a, b) => b.bytes - a.bytes);
              topFiles.length = 20;
            }
          }
        }
      } catch {}
    }
  };
  await walk(dir, depth, relPrefix);
  if (topFiles) topFiles.sort((a, b) => b.bytes - a.bytes);
  return topFiles ? { files, bytes, topFiles: topFiles.slice(0, 20) } : { files, bytes };
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const sizeLine = (label, st) => `${label}：${st.files} 个文件，${mb(st.bytes)}`;

// 系统缓存目录下的具名子目录：图片缓存走 Glide（image_cache），地图瓦片在 WebView 的
// HTTP 缓存里，临时缩略图是 expo-video-thumbnails 的产物——能认出名字就写清楚用途
const CACHE_DIR_LABELS = {
  image_cache: '图片缓存 image_cache（列表封面缩略图）',
  VideoThumbnails: '临时缩略图 VideoThumbnails',
  WebView: '地图/网页缓存 WebView',
  WebKit: '地图/网页缓存 WebKit',
  'expo-image': '图片缓存 expo-image',
  'com.hackemist.SDImageCache': '图片缓存 SDImageCache',
  'org.hackemist.SDImageCache': '图片缓存 SDImageCache',
  thumbs: '选图器缩略图 thumbs',
  ImageManipulator: '图片处理临时缓存 ImageManipulator',
  backups: '备份导出临时文件 backups',
};

// 「数据目录」诊断：根目录、副本/封面目录、各类缓存（封面帧 / 实况视频 / 图片 / 地图 /
// 临时文件）的文件数与体积，最后做一次真实写入测试
export const describeStorageAsync = async () => {
  const lines = [
    IS_EXTERNAL_STORAGE
      ? '数据目录：应用外部目录（Android/data，文件管理器能看到）'
      : isIOS()
        ? '数据目录：应用文档目录（可在系统「文件」App → 我的 iPhone → 印记中查看）'
        : '数据目录：内部存储（没有 root 看不到）',
    STORAGE_ROOT,
  ];
  // ① 持久目录：影像副本 / 封面小图，这两样删了记录就看不了了，单独列
  for (const [label, dir] of [['副本 media', MEDIA_DIR], ['封面 covers', COVERS_DIR]]) {
    try {
      const info = await FileSystem.getInfoAsync(dir).catch(() => ({ exists: false }));
      if (!info.exists) {
        lines.push(`${label}：目录还不存在`);
        continue;
      }
      lines.push(sizeLine(label, await dirStatsAsync(dir, 1)));
    } catch (e) {
      lines.push(`${label}：读取失败（${e?.message || e}）`);
    }
  }
  // ② 可再生缓存（删了会自动重建，侧边栏「清理缓存」清的也是这些）
  const cacheDirs = [
    ['封面帧 videoThumbs（视频封面）', `${FileSystem.documentDirectory}videoThumbs`],
    ['实况视频 motionVideos（实况照片提取）', `${FileSystem.documentDirectory}motionVideos`],
  ];
  for (const [label, dir] of cacheDirs) {
    try {
      const st = await dirStatsAsync(dir);
      if (st.files > 0) {
        lines.push(sizeLine(label, st));
      } else if (label.includes('motionVideos')) {
        // 实况动效为空时把"为什么"也带上：以前失败是静默的，用户只能看到"暂无"
        const why = getLivePhotoError();
        lines.push(`实况视频 motionVideos：暂无（看过实况照片后会生成，进后台会清空）`
          + (why ? `\n  · 最近一次提取失败：${why}` : ''));
      } else {
        lines.push(`${label}：暂无`);
      }
    } catch (e) {
      lines.push(`${label}：读取失败（${e?.message || e}）`);
    }
  }
  // ③ 系统缓存目录：图片缓存（Glide）/ 地图瓦片（WebView HTTP 缓存）/ 临时文件都在这儿，
  //    按子目录分别列出体积，谁占地方一眼能看出来
  try {
    const cacheRoot = FileSystem.cacheDirectory;
    const names = await FileSystem.readDirectoryAsync(cacheRoot);
    const parts = [];
    let total = 0;
    for (const name of names) {
      const st = await dirStatsAsync(`${cacheRoot}${name}`);
      total += st.bytes;
      if (st.files > 0) parts.push({ name, ...st });
    }
    if (parts.length === 0) {
      lines.push('缓存 cache：空的');
    } else {
      parts.sort((a, b) => b.bytes - a.bytes);
      lines.push(`缓存 cache：合计 ${mb(total)}（「清理缓存」可一键释放）`);
      for (const p of parts.slice(0, 6)) {
        lines.push(`  · ${CACHE_DIR_LABELS[p.name] || p.name}：${mb(p.bytes)}（${p.files} 个文件）`);
      }
      if (parts.length > 6) lines.push(`  · 其余 ${parts.length - 6} 项小缓存`);
    }
  } catch (e) {
    lines.push(`缓存 cache：读取失败（${e?.message || e}）`);
  }
  // 写入测试最能说明问题：目录不存在也会先建，能写出来才算真的能用
  const probe = `${MEDIA_DIR}/.write-test`;
  try {
    await writeFileBase64Async(probe, 'b2s=');   // "ok"
    const st = await FileSystem.getInfoAsync(probe);
    // 探针也在 Android/data 里，删除同样得走原生（见 deletePathAsync 的说明）
    await deletePathAsync(probe);
    lines.push(`写入测试：${st.exists ? '通过' : '失败（文件没写出来）'}`);
  } catch (e) {
    lines.push(`写入测试：失败（${e?.message || e}）`);
  }
  return lines.join('\n');
};
