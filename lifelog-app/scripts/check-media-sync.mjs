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

const addDir = (path, names = []) => files.set(path, { dir: true, names });
const addFile = (path, size, mtime = 1700000000) => files.set(path, { dir: false, size, mtime });

const MEDIA = 'file:///data/user/0/app/files/media/';
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
    export const documentDirectory = 'file:///data/user/0/app/files/';
    export const cacheDirectory = 'file:///data/user/0/app/cache/';
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
    export const deleteAsync = async (uri) => {
      const f = store().files.get(uri);
      if (f && f.dir) {
        const prefix = uri + '/';
        for (const k of [...store().files.keys()]) if (k.startsWith(prefix)) store().files.delete(k);
      }
      store().files.delete(uri);
      store().removedPaths.push(uri);
      // 父目录的名字表同步摘掉，后面的 prune 才会看到"目录里真的没了"
      const parent = uri.slice(0, uri.lastIndexOf('/') + 1);
      const p = store().files.get(parent);
      if (p && p.dir) p.names = p.names.filter((n) => n !== uri.slice(parent.length));
    };
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
  'index.js': `export const requireOptionalNativeModule = () => null;`,
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
copySource('src/utils/storagePaths.js');
copySource('src/utils/media.js');
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
  { id: 3, title: '相册里找不到，只能靠副本显示', localImages: [
    { uri: MEDIA + 'share_d.jpg', filename: 'IMG_9.jpg', size: 999, isVideo: false },
  ] },
  { id: 4, title: '谁都没引用的孤儿副本', localImages: [] },
];

addDir(MEDIA.slice(0, -1));
addFile(MEDIA + 'share_a.jpg', 111);
addFile(MEDIA + 'share_b.jpg', 222);
addFile(MEDIA + 'share_c.jpg', 333);   // 孤儿
addFile(MEDIA + 'share_d.jpg', 999);
files.get(MEDIA.slice(0, -1)).names = ['share_a.jpg', 'share_b.jpg', 'share_c.jpg', 'share_d.jpg'];

const remaining = () => [...files.keys()].filter((k) => k.startsWith(MEDIA)).map((k) => k.slice(MEDIA.length)).sort();

/* ----------------------------------- 跑一遍 ----------------------------------- */
const { syncMediaFromGallery } = await import(pathToFileURL(mediaSyncPath).href);
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
// ③ 孤儿副本、以及两张刚被原片接管的副本，磁盘上都该没了
const left = remaining();
if (left.join(',') !== 'share_d.jpg') fail.push(`media/ 目录最后应只剩 share_d.jpg，实际 ${left.join(',') || '（空）'}`);
if (report.freedCopies !== 2) fail.push(`重链后直接删掉的副本应为 2 个，实际 ${report.freedCopies}`);
if (report.removedCopies !== 1) fail.push(`孤儿副本应清掉 1 个（share_c），实际 ${report.removedCopies}`);
if (report.freedBytes !== 333) fail.push(`孤儿副本应释放 333 字节，实际 ${report.freedBytes}`);
if (report.matched !== 2) fail.push(`重链条数应为 2，实际 ${report.matched}`);
if (report.unmatched.length !== 0) fail.push('这一份数据里不该有"无法恢复"的记录');
if (report.permissionDenied) fail.push('桩里相册权限是给的，不该报 permissionDenied');

console.log(`重链 ${report.matched} 条；删副本 ${report.freedCopies + report.removedCopies} 个（重链接管 ${report.freedCopies} + 孤儿 ${report.removedCopies}），释放 ${report.freedBytes} 字节`);
console.log(`media/ 目录还剩：${left.join(', ') || '（空）'}`);
if (fail.length) {
  console.error('✗ 自检未通过：\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log('✓ 通过：能引用相册的副本 / 指纹能对上的副本 / 没人引用的孤儿副本都会删掉，找不到原片的副本保留');
