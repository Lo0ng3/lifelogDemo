// 媒体引用解析：记录里只保存相册资产的引用（assetId）+ 一个备用 URI，
// 显示时通过 expo-media-library 把 assetId 实时解析成相册里的原始文件路径，
// 这样 App 内不会长期持有照片/视频的副本。
import * as MediaLibrary from 'expo-media-library';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system/legacy';

// 兼容两种历史数据形态：纯 URI 字符串（旧记录 / 网络图）和 { uri, assetId } 对象
export const normalizeMediaEntry = (entry) =>
  typeof entry === 'string' ? { uri: entry } : entry || null;

export const mediaUri = (entry) => normalizeMediaEntry(entry)?.uri;

// assetId -> 原始文件路径 的内存缓存，避免每次渲染都查询相册
const resolvedCache = new Map();

let permissionDenied = false;

export const resolveMediaUri = async (entry) => {
  const { uri, assetId } = normalizeMediaEntry(entry) || {};
  if (!assetId) return uri;
  if (resolvedCache.has(assetId)) return resolvedCache.get(assetId);

  // 用户拒绝过权限就不反复弹窗，直接用备用 URI
  if (permissionDenied) return uri;
  try {
    let perm = await MediaLibrary.getPermissionsAsync();
    if (!perm.granted) {
      perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        permissionDenied = true;
        return uri;
      }
    }
    const info = await MediaLibrary.getAssetInfoAsync(assetId);
    const localUri = info?.localUri || uri;
    resolvedCache.set(assetId, localUri);
    return localUri;
  } catch {
    // 资产可能已被删除或平台不支持，回退到保存时的 URI
    return uri;
  }
};

// assetId -> 封面帧 的内存缓存（视频九宫格缩略图用，避免挂载真实播放器）
const thumbCache = new Map();

export const getVideoThumbnail = async (entry) => {
  const { uri, assetId } = normalizeMediaEntry(entry) || {};
  if (!uri) return null;
  const cacheKey = assetId || uri;
  if (thumbCache.has(cacheKey)) return thumbCache.get(cacheKey);
  try {
    const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(uri, { time: 1000 });
    thumbCache.set(cacheKey, thumbUri);
    return thumbUri;
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

// 把网络海报下载到本地持久目录，作为离线可用的封面；失败时返回原网络地址
// 豆瓣图床有防盗链：必须带浏览器 UA + Referer，否则一律 418 拒绝
const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://www.douban.com/',
};

export const downloadRemoteCover = async (url) => {
  if (!url || !url.startsWith('http')) return url || null;
  try {
    const dir = `${FileSystem.documentDirectory}covers`;
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const ext = (url.split('?')[0].match(/\.(jpe?g|png|webp)$/i) || [])[1] || 'jpg';
    const dest = `${dir}/cover_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
    const { uri } = await FileSystem.downloadAsync(url, dest, { headers: DOWNLOAD_HEADERS });
    return uri;
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

// 一次性清理：旧版本用系统选择器选图时留在缓存里的媒体拷贝（App 占用膨胀的历史遗留）
export const cleanLegacyPickerCache = async () => {
  try {
    const legacyDir = `${FileSystem.cacheDirectory}ImagePicker`;
    const info = await FileSystem.getInfoAsync(legacyDir);
    if (info.exists) await FileSystem.deleteAsync(legacyDir, { idempotent: true });
  } catch {
    // 清理失败不影响使用
  }
};
