// 应用私有媒体的落点。默认在内部存储（/data/user/0/<包名>/files，没有 root 看不到），
// 原生模块 Paths 可用时改到应用专属外部目录
// （/storage/emulated/0/Android/data/<包名>/files），这样影像副本和封面能用手机
// 文件管理器直接翻到、手动拷走。
//
// 只搬 media 和 covers：这两样是用户可能想看的。videoThumbs / motionVideos 是纯缓存
// （有体积上限、删了自动重建），继续留在内部目录，不占 Android/data 的位置。
//
// 外部目录不可用（未挂载、iOS、同步调用失败）时不报错，静默回退内部目录。
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as FileSystem from 'expo-file-system/legacy';

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
const dirStatsAsync = async (dir, depth = 3) => {
  let files = 0;
  let bytes = 0;
  let scanned = 0;
  const walk = async (d, left) => {
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
      try {
        const info = await FileSystem.getInfoAsync(p);
        if (!info.exists) continue;
        if (info.isDirectory) {
          if (left > 0) await walk(p, left - 1);
          continue;
        }
        files++;
        if (typeof info.size === 'number') bytes += info.size;
      } catch {}
    }
  };
  await walk(dir, depth);
  return { files, bytes };
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const sizeLine = (label, st) => `${label}：${st.files} 个文件，${mb(st.bytes)}`;

// 系统缓存目录下的具名子目录：图片缓存走 Glide（image_cache），地图瓦片在 WebView 的
// HTTP 缓存里，临时缩略图是 expo-video-thumbnails 的产物——能认出名字就写清楚用途
const CACHE_DIR_LABELS = {
  image_cache: '图片缓存 image_cache（列表封面缩略图）',
  VideoThumbnails: '临时缩略图 VideoThumbnails',
  WebView: '地图/网页缓存 WebView',
  'expo-image': '图片缓存 expo-image',
};

// 「数据目录」诊断：根目录、副本/封面目录、各类缓存（封面帧 / 实况视频 / 图片 / 地图 /
// 临时文件）的文件数与体积，最后做一次真实写入测试
export const describeStorageAsync = async () => {
  const lines = [
    IS_EXTERNAL_STORAGE
      ? '数据目录：应用外部目录（Android/data，文件管理器能看到）'
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
      lines.push(st.files === 0
        ? `${label}：暂无${label.includes('motionVideos') ? '（看过实况照片后会生成，进后台会清空）' : ''}`
        : sizeLine(label, st));
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
