// 相册同步 / 副本清理的回归自检（不需要真机、不需要相册）：
// 用桩把 expo 的几个原生模块换成内存实现，然后跑真实的 mediaSync / media 代码，验证
//   ① 记录已经能引用相册原片（assetId 有效）时，media/ 里那份多余的副本会被删掉；
//   ② 断链的分享副本按文件名 / 大小指纹重链成功时，副本也会删掉；
//   ③ 谁都不引用的孤儿副本（所有记录都没提到这张图）会被清掉；
//   ④ 相册里找不到、指纹也对不上的副本必须留着（记录还得靠它显示，绝不能误删）；
//   ⑤ 清理结果里的数字（重链条数 / 删掉的副本数）要和实际动作对得上。
//
// 用法：node scripts/check-media-sync.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'rc-mediasync-'));
const fail = [];

/* ------------------------------- 桩：内存文件系统 ------------------------------- */
// 记录里 media/ 的副本、相册原片都放在这个内存表里；删除会真的从表里去掉，
// 这样"删没删掉"是能验证的
const files = new Map();
const removedPaths = [];
globalThis.__rcFS = { files, removedPaths };
globalThis.__rcAssets = [];
globalThis.__rcExternalDir = '/storage/emulated/0/Android/data/com.example/files';

const addDir = (path, names = []) => files.set(path, { dir: true, names });
const addFile = (path, size, mtime = 1700000000) => files.set(path, { dir: false, size, mtime });

// 真机上副本 / 封面落在应用专属外部目录（Android/data）——这一条是这次的关键：
// expo-file-system 的 deleteAsync 对**文件**拼 "<路径>/.." 判权限，必然失败，
// 只有原生 File API 删得掉。所以桩里也要按这个真实布局来。
const APP_ROOT = 'file:///storage/emulated/0/Android/data/com.example/files/';
const INTERNAL_ROOT = 'file:///data/user/0/com.example/files/';
const MEDIA = `${APP_ROOT}media/`;
const COVERS = `${APP_ROOT}covers/`;
const LEGACY_MEDIA = `${INTERNAL_ROOT}media/`;    // 1.8.2 之前用的内部目录，也要一起扫
const DCIM = 'file:///storage/emulated/0/DCIM/';

/* ---------------------------------- 写桩模块 ---------------------------------- */
const writePkg = (name, filesMap) => {
  const dir = join(scratch, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  const pkg = { name, version: '0.0.0', type: 'module' };
  if (filesMap['/'] !== undefined) pkg.main = filesMap['/'];
  // Node 的 ESM 解析要求子路径在 exports 里显式声明（真机上由 Metro 处理）
  if (name === 'expo-file-system') pkg.exports = { '.': './legacy.js', './legacy': './legacy.js' };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, code] of Object.entries(filesMap)) {
    if (rel === '/') continue;
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code.trimStart());
  }
};

writePkg('expo-file-system', {
  '/': 'legacy.js',
  'legacy.js': `
    const store = () => globalThis.__rcFS;
    export const documentDirectory = 'file:///data/user/0/com.example/files/';
    export const cacheDirectory = 'file:///data/user/0/com.example/cache/';
    export const EncodingType = { Base64: 'base64' };
    // 真机上沙盒外的**不存在**路径 getInfoAsync 会抛权限错，这里保持一致
    export const getInfoAsync = async (uri) => {
      const f = store().files.get(uri);
      if (!f) throw new Error("Location '" + uri + "' isn't readable.");
      return { exists: true, isDirectory: !!f.dir, size: f.dir ? 0 : f.size, modificationTime: f.mtime, uri };
    };
    export const readDirectoryAsync = async (dir) => {
      const f = store().files.get(dir);
      if (!f || !f.dir) throw new Error("Location '" + dir + "' isn't readable.");
      return f.names.slice();
    };
    const deleteReally = async (uri) => {
      const f = store().files.get(uri);
      if (f && f.dir) {
        const prefix = uri + '/';
        for (const k of [...store().files.keys()]) if (k.startsWith(prefix)) store().files.delete(k);
      }
      store().files.delete(uri);
      store().removedPaths.push(uri);
      // 父目录的名字表同步摘掉，后面的 prune 才会看到"目录里真的没了"。
      // 带不带结尾斜杠都试一遍：调用方拼的是 MEDIA_DIR（无斜杠）+ '/' + 文件名
      const parent = uri.slice(0, uri.lastIndexOf('/') + 1);
      const name = uri.slice(uri.lastIndexOf('/') + 1);
      const p = store().files.get(parent) || store().files.get(parent.slice(0, -1));
      if (p && p.dir) p.names = p.names.filter((n) => n !== name);
    };
    // 忠实复刻真机上的行为：deleteAsync 删之前会检查 "<uri>/.." 的写权限，给**文件**
    // 路径拼上 ".." 之后 stat 直接失败 → Android/data（外部目录）里的文件永远报
    // "isn't deletable"。内部目录（前缀判定）不受影响，所以内部的删除是好的。
    export const deleteAsync = async (uri) => {
      if (!uri.startsWith('file:///data/user/0/')) {
        throw new Error("Location '" + uri + "' isn't deletable.");
      }
      return await deleteReally(uri);
    };
    // 原生 Paths.deletePath 的桩：直接删（真机上就是 java.io.File.deleteRecursively）
    globalThis.__rcNativeDelete = deleteReally;
    export const makeDirectoryAsync = async (uri) => { store().files.set(uri, { dir: true, names: [] }); };
    export const copyAsync = async ({ from, to }) => { store().files.set(to, { dir: false, size: 1, mtime: 1700000000 }); };
    export const writeAsStringAsync = async () => {};
    export const downloadAsync = async () => ({ uri: '' });
  `,
});

writePkg('expo-media-library', {
  '/': 'index.js',
  'index.js': `
    export const getPermissionsAsync = async () => ({ granted: true });
    export const requestPermissionsAsync = async () => ({ granted: true });
    export const getAssetsAsync = async ({ mediaType }) => ({
      assets: globalThis.__rcAssets.filter((a) => a.mediaType === mediaType),
      hasNextPage: false,
      endCursor: null,
    });
    export const getAssetInfoAsync = async (id) => globalThis.__rcAssets.find((a) => a.id === id) || null;
  `,
});

writePkg('expo-modules-core', {
  '/': 'index.js',
  // 真机上 Paths 模块存在（外部目录 + 原生删除都是靠它）；这里给出同样的形状
  'index.js': `export const requireOptionalNativeModule = (name) => (name === 'Paths' ? {
    externalFilesDir: globalThis.__rcExternalDir,
    deletePath: (uri) => Promise.resolve(globalThis.__rcNativeDelete(uri)),
  } : null);`,
});
writePkg('expo-image', {
  '/': 'index.js',
  'index.js': `export const Image = { clearDiskCache: async () => {}, getSize: () => {} };`,
});
writePkg('expo-video-thumbnails', {
  '/': 'index.js',
  'index.js': `export const getThumbnailAsync = async () => ({ uri: '' });`,
});
writePkg('expo-image-manipulator', {
  '/': 'index.js',
  'index.js': `
    export const ImageManipulator = { manipulate: () => ({ resize: () => ({ renderAsync: async () => ({ saveAsync: async () => ({ uri: '' }) }) }) }) };
    export const SaveFormat = { JPEG: 'jpeg' };
  `,
});
writePkg('react-native', {
  '/': 'index.js',
  'index.js': `export const Image = { getSize: (uri, ok) => ok(100, 100) };`,
});

/* ------------------------------ 拷源码（改相对路径） ------------------------------ */
const copySource = (rel) => {
  const code = readFileSync(join(root, rel), 'utf8')
    .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.mjs'");
  const target = join(scratch, basename(rel).replace(/\.js$/, '.mjs'));
  writeFileSync(target, code);
  return target;
};
copySource('src/utils/diag.js');
copySource('src/utils/storagePaths.js');
const managePath = copySource('src/utils/media.js');
const mediaSyncPath = copySource('src/utils/mediaSync.js');

/* --------------------------------- 造一份数据 --------------------------------- */
// 相册里的两张原片（IMG_1 / IMG_2）
globalThis.__rcAssets = [
  { id: 'srv-1', filename: 'IMG_1.jpg', mediaType: 'photo', width: 100, height: 100, uri: DCIM + 'IMG_1.jpg', creationTime: 1 },
  { id: 'srv-2', filename: 'IMG_2.jpg', mediaType: 'photo', width: 100, height: 100, uri: DCIM + 'IMG_2.jpg', creationTime: 2 },
];
addFile(DCIM + 'IMG_1.jpg', 111);
addFile(DCIM + 'IMG_2.jpg', 222);

const logs = [
  { id: 1, title: '记录能引用相册，但副本还留着', localImages: [
    { uri: MEDIA + 'share_a.jpg', assetId: 'srv-1', filename: 'IMG_1.jpg', size: 111, isVideo: false },
  ] },
  { id: 2, title: '断链的分享副本（指纹能对上原片）', localImages: [
    { uri: MEDIA + 'share_b.jpg', filename: 'IMG_2.jpg', size: 222, isVideo: false },
  ] },
  { id: 3, title: '相册里找不到，只能靠副本显示', coverUrl: COVERS + 'cover_keep.jpg', localImages: [
    { uri: MEDIA + 'share_d.jpg', filename: 'IMG_9.jpg', size: 999, isVideo: false },
  ] },
  { id: 4, title: '谁都没引用的孤儿副本', localImages: [] },
];

addDir(MEDIA.slice(0, -1));
addFile(MEDIA + 'share_a.jpg', 111);
addFile(MEDIA + 'share_b.jpg', 222);
addFile(MEDIA + 'share_c.jpg', 333);   // 孤儿
addFile(MEDIA + 'share_d.jpg', 999);
addFile(MEDIA + 'share_e.jpg', 444);                                        // 还被「添加」页草稿挂着
addFile(MEDIA + 'share_f.jpg', 555, Math.floor(Date.now() / 1000) - 30);     // 刚导入 30 秒
files.get(MEDIA.slice(0, -1)).names = [
  'share_a.jpg', 'share_b.jpg', 'share_c.jpg', 'share_d.jpg', 'share_e.jpg', 'share_f.jpg', 'ghost.jpg',
];
// ghost.jpg 出现在目录列表里、但读不到文件信息（模拟权限/系统限制）→ 必须报出来且不删
// （它不在 files 表里，getInfoAsync 会抛错）

// 1.8.2 之前落在内部目录里的老副本：也要一起扫、一起清（内部目录 expo 的删除是好的）
addDir(LEGACY_MEDIA.slice(0, -1));
addFile(LEGACY_MEDIA + 'legacy_orphan.jpg', 321);
files.get(LEGACY_MEDIA.slice(0, -1)).names = ['legacy_orphan.jpg'];

// 封面小图：一张记录还在用，两张是孤儿
addDir(COVERS.slice(0, -1));
addFile(COVERS + 'cover_keep.jpg', 66);
addFile(COVERS + 'cover_orphan1.jpg', 77);
addFile(COVERS + 'cover_orphan2.jpg', 88);
files.get(COVERS.slice(0, -1)).names = ['cover_keep.jpg', 'cover_orphan1.jpg', 'cover_orphan2.jpg'];

// 直接看目录里的名字表（deleteAsync 会把名字从父目录摘掉），
// 这样"列表里有、但读不到信息"的 ghost.jpg 也在结果里
const mediaNames = () => (files.get(MEDIA.slice(0, -1))?.names || []).slice().sort();
const coverNames = () => (files.get(COVERS.slice(0, -1))?.names || []).slice().sort();
const legacyNames = () => (files.get(LEGACY_MEDIA.slice(0, -1))?.names || []).slice().sort();

/* ----------------------------------- 跑一遍 ----------------------------------- */
const { syncMediaFromGallery } = await import(pathToFileURL(mediaSyncPath).href);
const { setDraftMediaEntries, describeMediaCopiesAsync, purgeReferencedMediaCopies } = await import(pathToFileURL(managePath).href);
// 「添加」页表单里还挂着一张（草稿也算"在用"，同步不能删）
setDraftMediaEntries([{ uri: MEDIA + 'share_e.jpg' }]);
const report = await syncMediaFromGallery(logs);
const next = report.logs;
const entryOf = (id) => next.find((l) => l.id === id).localImages[0];
const parse = (u) => String(u).slice(String(u).lastIndexOf('/') + 1);

// ① 记录能引用相册原片 → 多余的副本删掉，条目换成相册原片
if (!report.changed) fail.push('这一轮应当有记录被重链（changed 应为 true）');
if (parse(entryOf(1).uri) !== 'IMG_1.jpg') fail.push(`记录 1 应换成相册原片，实际 ${entryOf(1).uri}`);
if (entryOf(1).assetId !== 'srv-1') fail.push('记录 1 的 assetId 不该被丢掉');
// ② 指纹重链：副本删掉，补上 assetId
if (entryOf(2).assetId !== 'srv-2') fail.push(`记录 2 没有重链到相册原片，实际 assetId=${entryOf(2).assetId}`);
if (parse(entryOf(2).uri) !== 'IMG_2.jpg') fail.push(`记录 2 应换成相册原片，实际 ${entryOf(2).uri}`);
// ④ 相册里找不到的副本必须留着（不然记录就没图可看了）
if (entryOf(3).uri !== MEDIA + 'share_d.jpg') fail.push('相册里找不到原片时不该改动条目，副本必须留着');
// ③ 孤儿副本、以及两张刚被原片接管的副本，磁盘上都该没了；草稿 / 刚导入 / 读不到的留着
const left = mediaNames();
if (left.join(',') !== 'ghost.jpg,share_d.jpg,share_e.jpg,share_f.jpg') {
  fail.push(`media/ 目录最后应剩 share_d / share_e / share_f / ghost，实际 ${left.join(',') || '（空）'}`);
}
if (report.freedCopies !== 2) fail.push(`重链后直接删掉的副本应为 2 个，实际 ${report.freedCopies}`);
// 孤儿副本：外部目录里的 share_c + 内部老目录里的 legacy_orphan，两个都要清掉
if (report.removedCopies !== 2) fail.push(`孤儿副本应清掉 2 个（share_c + legacy_orphan），实际 ${report.removedCopies}`);
if (report.freedBytes !== 333 + 321) fail.push(`孤儿副本应释放 ${333 + 321} 字节，实际 ${report.freedBytes}`);
// 关键回归：外部目录（Android/data）里的文件只能用原生删除，走 expo 的 deleteAsync 必失败
if (legacyNames().length !== 0) fail.push(`内部老目录里的孤儿副本应当被清掉，实际还剩 ${legacyNames().join(',')}`);
if (report.failedToDelete?.count) {
  fail.push(`不该有删不掉的副本，实际 ${report.failedToDelete.count} 个：${(report.failedToDelete.reasons || []).join('；')}`);
}
if (report.matched !== 2) fail.push(`重链条数应为 2，实际 ${report.matched}`);
if (report.unmatched.length !== 0) fail.push('这一份数据里不该有"无法恢复"的记录');
if (report.permissionDenied) fail.push('桩里相册权限是给的，不该报 permissionDenied');

// ⑤ 剩下的副本要如实分类报出来（这就是"点了同步却说没有多余的"的答案）
const copiesLeft = report.copiesLeft || {};
if (copiesLeft.referenced !== 1) fail.push(`应报出 1 个"仍被记录引用"的副本，实际 ${copiesLeft.referenced}`);
if (copiesLeft.draft !== 1) fail.push(`应报出 1 个"还在添加页草稿里"的副本，实际 ${copiesLeft.draft}`);
if (copiesLeft.fresh !== 1) fail.push(`应报出 1 个"刚导入不到 5 分钟"的副本，实际 ${copiesLeft.fresh}`);
if (copiesLeft.unreadable !== 1) fail.push(`应报出 1 个"读不到文件信息"的副本，实际 ${copiesLeft.unreadable}`);

// ⑥ 封面小图：记录还在用的留着，孤儿删掉
if (report.removedCovers !== 2) fail.push(`孤儿封面应清掉 2 张，实际 ${report.removedCovers}`);
if (coverNames().join(',') !== 'cover_keep.jpg') {
  fail.push(`covers/ 最后应只剩被记录引用的那张，实际 ${coverNames().join(',') || '（空）'}`);
}

// ⑦ 「数据目录」里的副本明细要说清楚每一类各有多少
const detailRes = await describeMediaCopiesAsync(logs);
const detail = detailRes.text;
if (detailRes.draft !== 1) fail.push(`副本明细应报出 1 个草稿副本（给"清空草稿"按钮用），实际 ${detailRes.draft}`);
if (detailRes.orphan !== 0) fail.push(`同步之后不该还有可清理的副本，实际 ${detailRes.orphan}`);
if (!/记录引用 1/.test(detail) || !/添加页草稿 1/.test(detail) || !/可清理 0/.test(detail)) {
  fail.push(`副本明细的计数不对：${detail.replace(/\n/g, ' | ')}`);
}
if (!/封面小图 covers：共 1 张，其中 0 张没有记录引用/.test(detail)) {
  fail.push(`副本明细里的封面统计不对：${detail.replace(/\n/g, ' | ')}`);
}
if (!/读不到信息 1/.test(detail)) fail.push('副本明细里没有把"读不到文件信息"报出来');

// ⑧ 草稿清掉之后再同步一次：那张副本这时才该被清掉
setDraftMediaEntries([]);
const report2 = await syncMediaFromGallery(next);
if (report2.copiesLeft?.draft !== 0) fail.push('清空草稿后不该再报"草稿里还有副本"');
if (mediaNames().includes('share_e.jpg')) fail.push('草稿清空后，share_e.jpg 这次同步应当被清掉');
if (report2.removedCopies !== 1) fail.push(`第二次同步应清掉 1 个（share_e），实际 ${report2.removedCopies}`);

// ⑨ 用户确认清除「仍被记录引用且相册里找不到原片」的副本：删文件并从记录中移除对应照片
if (!report.referencedLogs?.some((r) => r.id === 3)) {
  fail.push(`report.referencedLogs 应包含记录 3，实际 ${JSON.stringify(report.referencedLogs)}`);
}
const purged = await purgeReferencedMediaCopies(next);
if (!purged.changed || purged.removed !== 1 || purged.freed !== 999 || purged.affectedLogs !== 1) {
  fail.push(`purgeReferencedMediaCopies 结果不对：${JSON.stringify({ changed: purged.changed, removed: purged.removed, freed: purged.freed, affectedLogs: purged.affectedLogs })}`);
}
if (mediaNames().includes('share_d.jpg')) fail.push('确认清除后 share_d.jpg 应当已从磁盘删除');
if ((purged.logs.find((l) => l.id === 3)?.localImages || []).length !== 0) {
  fail.push('确认清除后记录 3 里的副本照片条目应当被移除');
}

console.log(`重链 ${report.matched} 条；删副本 ${report.freedCopies + report.removedCopies} 个（重链接管 ${report.freedCopies} + 孤儿 ${report.removedCopies}），释放 ${report.freedBytes} 字节`);
console.log(`media/ 目录还剩：${left.join(', ') || '（空）'}（记录引用 ${copiesLeft.referenced} / 草稿 ${copiesLeft.draft} / 刚导入 ${copiesLeft.fresh} / 读不到 ${copiesLeft.unreadable}）`);
console.log(`封面小图：删了 ${report.removedCovers} 张没人引用的，还剩 ${coverNames().join(', ') || '（空）'}`);
console.log(`第二次同步（草稿已清空）：又清掉 ${report2.removedCopies} 个副本`);
console.log('Android/data 的删除回归：桩里 expo 的 deleteAsync 对文件必然失败，以上清理全部走原生删除才可能通过');
if (fail.length) {
  console.error('✗ 自检未通过：\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log('✓ 通过：能引用相册的副本 / 指纹能对上的副本 / 没人引用的孤儿副本（含孤儿封面）都会删掉；找不到原片的、草稿里的、刚导入的、读不到的副本保留并如实报出原因');
