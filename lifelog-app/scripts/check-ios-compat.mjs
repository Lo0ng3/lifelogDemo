// iOS 兼容性与核心链路回归自检（不需要真机 / macOS）：
// 桩掉 expo 原生模块并模拟 Platform.OS = 'ios'，验证：
//   ① iOS 升级后沙盒容器 UUID 变化：rebaseAppFileUri / rebaseLogFileUris 正确重定位本地路径；
//   ② 备份导出走系统 Share Sheet（写入 cache/backups/*.json 并调 Share.share），支持取消与成功；
//   ③ iOS 实况照片识别 mediaSubtypes=['livePhoto']，tmp 配对视频失效时自动重拉；
//   ④ iOS 视频封面与 ph:// 设封面走 PhotoKit 原生 Thumbs，不撞 expo-video-thumbnails / FileSystem 沙盒限制；
//   ⑤ iOS 相册同步（asset.uri = ph://）通过 Thumbs.getAssetFileSizeAsync 完成指纹匹配与副本清理；
//   ⑥ 静态检查：app.json / 原生模块配置 / 无 iOS 非法 fontWeight（如 '650'）。
//
// 用法：node scripts/check-ios-compat.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'rc-ios-compat-'));
const fail = [];

const OLD_DOC = 'file:///var/mobile/Containers/Data/Application/11111111-OLD-UUID/Documents/';
const NEW_DOC = 'file:///var/mobile/Containers/Data/Application/22222222-NEW-UUID/Documents/';
const CACHE = 'file:///var/mobile/Containers/Data/Application/22222222-NEW-UUID/Library/Caches/';

const files = new Map();
const shareCalls = [];
const thumbCalls = [];
const assetInfoCalls = [];
let shareAction = 'sharedAction';
let pairedVideoAlive = true;

globalThis.__iosTest = {
  files,
  shareCalls,
  thumbCalls,
  assetInfoCalls,
  getShareAction: () => shareAction,
  isPairedAlive: () => pairedVideoAlive,
  assets: [],
};

const addDir = (path, names = []) => files.set(path, { dir: true, names });
const addFile = (path, size = 100, mtime = 1700000000, content = '') =>
  files.set(path, { dir: false, size, mtime, content });

const writePkg = (name, filesMap, exportsMap = null) => {
  const dir = join(scratch, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  const pkg = { name, version: '0.0.0', type: 'module' };
  if (filesMap['/'] !== undefined) pkg.main = filesMap['/'];
  if (exportsMap) pkg.exports = exportsMap;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, code] of Object.entries(filesMap)) {
    if (rel === '/') continue;
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code.trimStart());
  }
};

writePkg('react-native', {
  '/': 'index.js',
  'index.js': `
    export const Platform = { OS: 'ios' };
    export const Image = { getSize: (uri, ok, err) => err ? err(new Error('not supported')) : null };
    export const Share = {
      sharedAction: 'sharedAction',
      dismissedAction: 'dismissedAction',
      share: async (payload) => {
        globalThis.__iosTest.shareCalls.push(payload);
        return { action: globalThis.__iosTest.getShareAction() };
      },
    };
  `,
});

writePkg('@react-native-async-storage/async-storage', {
  '/': 'index.js',
  'index.js': `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`,
});

writePkg('expo-file-system', {
  '/': 'index.js',
  'index.js': `
    export class File {
      constructor(uri) { this.uri = uri; }
      async bytes() { return new Uint8Array(0); }
      write() {}
    }
  `,
  'legacy.js': `
    const store = () => globalThis.__iosTest.files;
    export const documentDirectory = '${NEW_DOC}';
    export const cacheDirectory = '${CACHE}';
    export const EncodingType = { UTF8: 'utf8', Base64: 'base64' };
    export const StorageAccessFramework = undefined;
    export const getInfoAsync = async (uri) => {
      if (String(uri).startsWith('ph://')) throw new Error('ph:// not supported by FileSystem');
      const f = store().get(uri);
      if (!f) return { exists: false, isDirectory: false, uri };
      return { exists: true, isDirectory: !!f.dir, size: f.size || 0, modificationTime: f.mtime || 1700000000, uri };
    };
    export const readDirectoryAsync = async (dir) => {
      const f = store().get(dir);
      if (!f || !f.dir) throw new Error('dir not found: ' + dir);
      return f.names.slice();
    };
    export const makeDirectoryAsync = async (uri) => {
      if (!store().has(uri)) store().set(uri, { dir: true, names: [] });
    };
    export const copyAsync = async ({ from, to }) => {
      const src = store().get(from);
      store().set(to, { dir: false, size: src?.size || 42, mtime: 1700000000 });
    };
    export const writeAsStringAsync = async (uri, content) => {
      store().set(uri, { dir: false, size: content.length, mtime: 1700000000, content });
    };
    export const readAsStringAsync = async (uri) => store().get(uri)?.content || '';
    export const deleteAsync = async (uri) => {
      store().delete(uri);
      const cut = uri.lastIndexOf('/');
      const p = store().get(uri.slice(0, cut));
      if (p?.dir) p.names = p.names.filter((n) => n !== uri.slice(cut + 1));
    };
  `,
}, { '.': './index.js', './legacy': './legacy.js' });

writePkg('expo-modules-core', {
  '/': 'index.js',
  'index.js': `
    const store = () => globalThis.__iosTest.files;
    export const requireOptionalNativeModule = (name) => {
      if (name === 'Paths') {
        return {
          externalFilesDir: '',
          getExternalFilesDir: () => '',
          ensureDir: async (dir) => {
            if (!store().has(dir)) store().set(dir, { dir: true, names: [] });
            return true;
          },
          copyFile: async (from, to) => {
            const src = store().get(from);
            store().set(to, { dir: false, size: src?.size || 42, mtime: 1700000000 });
            return true;
          },
          deletePath: async (uri) => {
            store().delete(uri);
            const cut = uri.lastIndexOf('/');
            const p = store().get(uri.slice(0, cut));
            if (p?.dir) p.names = p.names.filter((n) => n !== uri.slice(cut + 1));
            return true;
          },
          clearWebKitCache: async () => true,
        };
      }
      if (name === 'Thumbs') {
        return {
          getThumbnailAsync: async (assetId, isVideo, size) => {
            globalThis.__iosTest.thumbCalls.push({ assetId, isVideo, size });
            const safeId = String(assetId).replace(/[/:]/g, '_');
            const out = '${CACHE}thumbs/thumb_' + (isVideo ? 'v' : 'i') + '_' + safeId + '_' + size + '.jpg';
            store().set(out, { dir: false, size: 1234, mtime: 1700000000 });
            return { uri: out };
          },
          getAssetFileSizeAsync: async (assetId) => {
            const a = globalThis.__iosTest.assets.find((x) => x.id === assetId);
            return a ? a._fileSize : null;
          },
          getLivePhotoStatusAsync: async (assetId) => {
            const a = globalThis.__iosTest.assets.find((x) => x.id === assetId);
            return !!a?.mediaSubtypes?.includes('livePhoto');
          },
          getLivePhotoVideoUriAsync: async (assetId) => {
            const a = globalThis.__iosTest.assets.find((x) => x.id === assetId);
            if (!a?.mediaSubtypes?.includes('livePhoto')) return null;
            const out = 'file:///tmp/livePhotos/live_' + globalThis.__iosTest.assetInfoCalls.length + '_' + Date.now() + '.mov';
            store().set(out, { dir: false, size: 500000, mtime: 1700000000 });
            return out;
          },
          getPlayableVideoUriAsync: async (assetId) => {
            const out = 'file:///tmp/playableVideos/vid_' + String(assetId).replace(/[/:]/g, '_') + '.mov';
            store().set(out, { dir: false, size: 9876543, mtime: 1700000000 });
            return out;
          },
        };
      }
      return null;
    };
  `,
});

writePkg('expo-media-library', {
  '/': 'index.js',
  'index.js': `
    export const getPermissionsAsync = async () => ({ granted: true, accessPrivileges: 'all' });
    export const requestPermissionsAsync = async () => ({ granted: true, accessPrivileges: 'all' });
    export const getAssetsAsync = async ({ mediaType }) => ({
      assets: globalThis.__iosTest.assets.filter((a) => a.mediaType === mediaType),
      hasNextPage: false,
      endCursor: null,
    });
    export const getAssetInfoAsync = async (id, opts) => {
      globalThis.__iosTest.assetInfoCalls.push({ id, opts });
      const a = globalThis.__iosTest.assets.find((x) => x.id === id);
      if (!a) return null;
      if (a.mediaSubtypes?.includes('livePhoto')) {
        const tmpUri = 'file:///tmp/live_' + globalThis.__iosTest.assetInfoCalls.length + '.mov';
        if (globalThis.__iosTest.isPairedAlive()) {
          globalThis.__iosTest.files.set(tmpUri, { dir: false, size: 500000, mtime: 1700000000 });
        }
        return { ...a, localUri: 'file:///var/mobile/Media/DCIM/IMG_LIVE.HEIC', pairedVideoAsset: { uri: tmpUri } };
      }
      return { ...a, localUri: 'file:///var/mobile/Media/DCIM/' + a.filename };
    };
  `,
});

writePkg('expo-image', {
  '/': 'index.js',
  'index.js': `export const Image = { clearDiskCache: async () => {} };`,
});

writePkg('expo-video-thumbnails', {
  '/': 'index.js',
  'index.js': `export const getThumbnailAsync = async () => { throw new Error('Should not hit expo-video-thumbnails for iOS PHAsset videos'); };`,
});

writePkg('expo-image-manipulator', {
  '/': 'index.js',
  'index.js': `
    export const ImageManipulator = { manipulate: () => ({ resize: () => ({ renderAsync: async () => ({ saveAsync: async () => ({ uri: '${CACHE}im.jpg' }) }) }) }) };
    export const SaveFormat = { JPEG: 'jpeg' };
  `,
});

const copySource = (rel) => {
  const code = readFileSync(join(root, rel), 'utf8')
    .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.mjs'");
  const target = join(scratch, basename(rel).replace(/\.js$/, '.mjs'));
  writeFileSync(target, code);
  return target;
};

copySource('src/utils/diag.js');
const storagePathsPath = copySource('src/utils/storagePaths.js');
const livePhotoPath = copySource('src/utils/livePhoto.js');
const mediaPath = copySource('src/utils/media.js');
const mediaSyncPath = copySource('src/utils/mediaSync.js');
const backupPath = copySource('src/utils/backup.js');

const { rebaseAppFileUri, rebaseLogFileUris, clearWebKitCacheAsync, describeStorageAsync } = await import(pathToFileURL(storagePathsPath).href);
const { getLivePhotoInfo, extractMotionVideo, clearMotionVideoCache } = await import(pathToFileURL(livePhotoPath).href);
const { getVideoThumbnail, downscaleCover, resolveMediaUri, resolvePlayableVideoUri } = await import(pathToFileURL(mediaPath).href);
const { syncMediaFromGallery } = await import(pathToFileURL(mediaSyncPath).href);
const { exportBackup } = await import(pathToFileURL(backupPath).href);

/* ① 路径重定位（iOS 容器 UUID 变更） */
const rebasedCover = rebaseAppFileUri(`${OLD_DOC}covers/cover_1.jpg`);
if (rebasedCover !== `${NEW_DOC}covers/cover_1.jpg`) {
  fail.push(`rebaseAppFileUri 未正确重定位封面路径：实际 ${rebasedCover}`);
}
const rebasedLog = rebaseLogFileUris({
  id: 1,
  coverUrl: `${OLD_DOC}covers/a.jpg`,
  coverThumbUrl: `${OLD_DOC}covers/a_t.jpg`,
  localImages: [{ uri: `${OLD_DOC}media/x.jpg`, videoPoster: { uri: `${OLD_DOC}videoPosters/p.jpg` } }],
});
if (
  rebasedLog.coverUrl !== `${NEW_DOC}covers/a.jpg` ||
  rebasedLog.coverThumbUrl !== `${NEW_DOC}covers/a_t.jpg` ||
  rebasedLog.localImages[0].uri !== `${NEW_DOC}media/x.jpg` ||
  rebasedLog.localImages[0].videoPoster.uri !== `${NEW_DOC}videoPosters/p.jpg`
) {
  fail.push('rebaseLogFileUris 未完整重定位记录里的本地路径');
}

/* ② 备份导出（iOS Share Sheet） */
shareAction = 'sharedAction';
const expOk = await exportBackup([{ id: 1, date: '2026-10-01', title: '测试' }]);
if (!expOk.ok || shareCalls.length !== 1 || !shareCalls[0].url.startsWith(`${CACHE}backups/lifelog-backup-`)) {
  fail.push(`iOS 导出备份未走 Share Sheet：${JSON.stringify(expOk)}`);
}
shareAction = 'dismissedAction';
const expCancel = await exportBackup([{ id: 1, date: '2026-10-01', title: '测试' }]);
if (!expCancel.canceled || expCancel.ok) {
  fail.push('iOS 取消分享未正确返回 canceled=true');
}

/* ③ iOS 实况照片检测与 tmp 配对视频失效重拉 */
const liveId = '91B1C271-C617-49CE-A074-E391BA7F843F/L0/001';
const vidId = 'AAAA1111-BBBB-2222-CCCC-333344445555/L0/001';
globalThis.__iosTest.assets = [
  { id: liveId, filename: 'IMG_0001.HEIC', mediaType: 'photo', mediaSubtypes: ['livePhoto'], width: 4032, height: 3024, uri: `ph://${liveId}`, _fileSize: 2345678 },
  { id: vidId, filename: 'IMG_0002.MOV', mediaType: 'video', mediaSubtypes: [], width: 1920, height: 1080, uri: `ph://${vidId}`, _fileSize: 9876543 },
];

const liveInfo = await getLivePhotoInfo({ assetId: liveId, uri: `ph://${liveId}` }, { full: true });
if (!liveInfo.live || assetInfoCalls.length !== 0) {
  fail.push(`iOS livePhoto 应走原生 PhotoKit 判定且零 getAssetInfoAsync：${JSON.stringify(liveInfo)}, calls=${assetInfoCalls.length}`);
}
const firstMov = await extractMotionVideo({ assetId: liveId, uri: `ph://${liveId}` }, liveInfo);
if (!firstMov || !firstMov.startsWith('file:///tmp/livePhotos/')) {
  fail.push(`iOS 实况未走原生 PHAssetResourceManager 导出配对视频：${firstMov}`);
}
// 模拟系统清掉了 tmp 里的配对视频，且清掉了内存缓存（重开 App）
files.delete(firstMov);
clearMotionVideoCache();
const freshMov = await extractMotionVideo({ assetId: liveId, uri: `ph://${liveId}` }, liveInfo);
if (!freshMov || !freshMov.startsWith('file:///tmp/livePhotos/')) {
  fail.push(`iOS 实况 tmp 失效后未重新拉取配对视频：${freshMov}`);
}

/* ③-b iOS 照片直读 ph://（不调 getAssetInfoAsync）+ 视频按需导出沙盒可播放地址 */
const resolvedPhoto = await resolveMediaUri({ assetId: liveId, uri: `ph://${liveId}` });
if (resolvedPhoto !== `ph://${liveId}` || assetInfoCalls.length !== 0) {
  fail.push(`iOS 照片解析应直接返回 ph:// 避免卡顿：${resolvedPhoto}`);
}
const playableVid = await resolvePlayableVideoUri({ assetId: vidId, uri: `ph://${vidId}`, isVideo: true });
if (!playableVid || !playableVid.startsWith('file:///tmp/playableVideos/')) {
  fail.push(`iOS 视频未导出为沙盒可播放路径：${playableVid}`);
}

/* ④ iOS 视频封面（走 Thumbs）与 ph:// 设封面 */
const vThumb = await getVideoThumbnail({ assetId: vidId, uri: `ph://${vidId}`, isVideo: true });
if (!vThumb || !thumbCalls.some((c) => c.assetId === vidId && c.isVideo === true)) {
  fail.push(`iOS 相册视频封面未走原生 Thumbs：${vThumb}`);
}
const coverFromPh = await downscaleCover(`ph://${liveId}`);
if (!coverFromPh || !coverFromPh.startsWith(`${NEW_DOC}covers/`)) {
  fail.push(`iOS ph:// 设为封面失败：${coverFromPh}`);
}

/* ⑤ iOS 相册同步（ph:// 资产按 PHAssetResource 体积指纹重链并删副本） */
const mediaDir = `${NEW_DOC}media`;
addDir(mediaDir, ['shared_copy.heic']);
addFile(`${mediaDir}/shared_copy.heic`, 2345678, 1700000000);
const syncRes = await syncMediaFromGallery([
  { id: 10, title: '分享照片', localImages: [{ uri: `${mediaDir}/shared_copy.heic`, filename: 'IMG_0001.HEIC', size: 2345678, isVideo: false }] },
]);
if (!syncRes.changed || syncRes.matched !== 1 || syncRes.logs[0].localImages[0].assetId !== liveId) {
  fail.push(`iOS 相册同步重链失败：${JSON.stringify({ changed: syncRes.changed, matched: syncRes.matched })}`);
}
if (syncRes.logs[0].localImages[0].liveStatus !== 'live') {
  fail.push(`iOS 重链后未直接写入 liveStatus='live'：${syncRes.logs[0].localImages[0].liveStatus}`);
}
if (syncRes.freedCopies !== 1) {
  fail.push(`iOS 重链后未删除多余副本：freedCopies=${syncRes.freedCopies}`);
}

/* ⑥ WKWebView 缓存清理与数据目录文案 */
if (!(await clearWebKitCacheAsync())) fail.push('clearWebKitCacheAsync 返回失败');
const desc = await describeStorageAsync();
if (!desc.includes('文件')) fail.push(`iOS 数据目录文案未包含「文件」App 提示：${desc}`);

/* ⑦ 静态检查：app.json / 原生模块 / fontWeight */
const appJson = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
if (!appJson.expo?.ios?.bundleIdentifier) fail.push('app.json 缺少 ios.bundleIdentifier');
if (!appJson.expo?.ios?.buildNumber) fail.push('app.json 缺少 ios.buildNumber');
if (!appJson.expo?.ios?.infoPlist?.UIFileSharingEnabled) fail.push('app.json 缺少 UIFileSharingEnabled');
const sharePlugin = (appJson.expo?.plugins || []).find((p) => Array.isArray(p) && p[0] === 'expo-share-intent');
if (!sharePlugin || sharePlugin[1]?.disableIOS) fail.push('app.json 尚未启用 expo-share-intent 的 iOS 支持');

for (const mod of ['paths', 'thumbs']) {
  const cfg = JSON.parse(readFileSync(join(root, 'modules', mod, 'expo-module.config.json'), 'utf8'));
  if (!cfg.platforms?.includes('ios') || !cfg.ios?.modules?.length) {
    fail.push(`modules/${mod}/expo-module.config.json 未配置 iOS 平台`);
  }
}
if (!existsSync(join(root, 'modules/paths/ios/PathsModule.swift'))) fail.push('缺少 PathsModule.swift');
if (!existsSync(join(root, 'modules/paths/ios/LiquidGlassView.swift'))) fail.push('缺少 LiquidGlassView.swift');
if (!existsSync(join(root, 'modules/paths/ios/Paths.podspec'))) fail.push('缺少 Paths.podspec');
const thumbsSwift = readFileSync(join(root, 'modules/thumbs/ios/ThumbsModule.swift'), 'utf8');
if (!thumbsSwift.includes('replacingOccurrences(of: "/"')) {
  fail.push('ThumbsModule.swift 未对 iOS assetId 中的 "/" 做文件名转义');
}

const VALID_WEIGHTS = new Set(['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900']);
const walkJs = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walkJs(p); continue; }
    if (!name.endsWith('.js')) continue;
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/fontWeight\s*:\s*['"]([^'"]+)['"]/g)) {
      if (!VALID_WEIGHTS.has(m[1])) fail.push(`发现 iOS 不兼容的 fontWeight '${m[1]}'：${p}`);
    }
  }
};
walkJs(join(root, 'src'));

if (fail.length) {
  console.error('✗ iOS 自检未通过：\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log('✓ 通过：iOS 路径重定位 / Share Sheet 备份 / Live Photo 检测与重拉 / PhotoKit 缩略图与设封面 / ph:// 相册同步 / WKWebView 缓存清理 / 原生配置与样式检查全部通过');
