// 实况照片「提取动效」的回归自检（不需要真机、不需要相册）：
// 用桩把 expo-file-system 的新旧两套 API 换成内存实现，然后跑真实的 livePhoto.js，验证
//   ① 只读文件尾那一段，绝不整文件读——30MB 的大图 + 1.2MB 动效，读取量必须远小于整文件；
//   ② 写出的 mp4 正好是内嵌的那一段，后面的私有尾数据要被裁掉（mp4CleanEnd 仍然生效）；
//   ③ 同一张照片第二次调用是纯内存命中：一次文件 IO 都不再发生（"点第二次不用等"）；
//   ④ clearMotionVideoCache() 之后会重新提取（进后台清空目录时就是这条路径）；
//   ⑤ 没有 videoLength 标记时靠尾部窗口扫 ftyp 也能提取出同样的内容。
//
// 用法：node scripts/check-live-photo.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'rc-livephoto-'));
const fail = [];
const MB = 1024 * 1024;

/* ------------------------------ 内存文件系统桩 ------------------------------ */
const files = new Map();          // uri → Uint8Array
const reads = [];                 // { uri, offset, length }
const writes = [];                // { uri, length }
let bytesRead = 0;
// 原生只读区间读的桩：真机上就是 Paths.readFileRange（"r" 打开，相册照片也能读）
const readRange = (uri, offset, length) => {
  const f = files.get(uri);
  if (!f) return new Uint8Array(0);
  const start = Math.max(0, Math.min(f.length, Math.floor(offset)));
  const len = Math.max(0, Math.min(f.length - start, Math.floor(length)));
  const out = f.slice(start, start + len);
  reads.push({ uri, offset: start, length: out.length });
  bytesRead += out.length;
  return out;
};
globalThis.__rcNewFS = {
  files, reads, writes, readRange,
  get bytesRead() { return bytesRead; },
  addBytesRead: (n) => { bytesRead += n; },
  resetReads: () => { reads.length = 0; bytesRead = 0; },
};
globalThis.__rcExternalDir = '/storage/emulated/0/Android/data/com.example/files';
globalThis.__rcReadRange = readRange;

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

writePkg('expo-file-system', {
  '/': 'index.js',
  'index.js': `
    const store = () => globalThis.__rcNewFS;
    export class File {
      constructor(uri) { this.uri = uri; }
      get exists() { return store().files.has(this.uri); }
      get size() { const f = store().files.get(this.uri); return f ? f.length : 0; }
      open() { return new FileHandle(this.uri); }
      write(bytes) {
        store().files.set(this.uri, Uint8Array.from(bytes));
        store().writes.push({ uri: this.uri, length: bytes.length });
      }
      delete() { store().files.delete(this.uri); }
    }
    class FileHandle {
      constructor(uri) { this.uri = uri; this._offset = 0; }
      get size() { const f = store().files.get(this.uri); return f ? f.length : 0; }
      get offset() { return this._offset; }
      set offset(v) { this._offset = v; }
      readBytes(length) {
        const f = store().files.get(this.uri);
        if (!f) throw new Error('file not found: ' + this.uri);
        const end = Math.min(f.length, this._offset + length);
        const out = f.slice(this._offset, end);
        store().reads.push({ uri: this.uri, offset: this._offset, length: out.length });
        store().addBytesRead(out.length);
        this._offset = end;
        return out;
      }
      close() {}
    }
  `,
  'legacy.js': `
    const store = () => globalThis.__rcNewFS;
    export const documentDirectory = 'file:///data/user/0/com.example/files/';
    export const cacheDirectory = 'file:///data/user/0/com.example/cache/';
    export const EncodingType = { UTF8: 'utf8', Base64: 'base64' };
    export const getInfoAsync = async (uri) => {
      const f = store().files.get(uri);
      return f ? { exists: true, isDirectory: false, size: f.length, modificationTime: 1700000000, uri } : { exists: false, isDirectory: false };
    };
    export const makeDirectoryAsync = async () => {};
    export const readAsStringAsync = async () => '';
    export const deleteAsync = async () => {};
    export const copyAsync = async () => {};
  `,
}, { '.': './index.js', './legacy': './legacy.js' });

writePkg('@react-native-async-storage/async-storage', {
  '/': 'index.js',
  'index.js': `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`,
});
writePkg('react-native', {
  '/': 'index.js',
  'index.js': `export const Platform = { OS: 'android' };`,
});
writePkg('expo-media-library', {
  '/': 'index.js',
  'index.js': `export const getAssetInfoAsync = async () => null;`,
});
// 真机上 Paths 模块存在（外部目录 + 原生删除 + 只读区间读都靠它）；这里给出同样的形状
writePkg('expo-modules-core', {
  '/': 'index.js',
  'index.js': `export const requireOptionalNativeModule = (name) => (name === 'Paths' ? {
    externalFilesDir: globalThis.__rcExternalDir,
    deletePath: (uri) => Promise.resolve(globalThis.__rcNativeDelete(uri)),
    readFileRange: (uri, offset, length) => Promise.resolve(globalThis.__rcReadRange(uri, offset, length)),
  } : null);`,
});

/* ------------------------------ 拷源码（本身就是纯 ESM） ------------------------------ */
const copySource = (rel) => {
  // 源码是给 metro 看的 ESM-in-.js：复制成 .mjs 并给相对导入补后缀，node 才解析得了
  const code = readFileSync(join(root, rel), 'utf8')
    .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.mjs'");
  const target = join(scratch, basename(rel).replace(/\.js$/, '.mjs'));
  writeFileSync(target, code);
  return target;
};
copySource('src/utils/storagePaths.js');
const livePhotoPath = copySource('src/utils/livePhoto.js');

/* ------------------------------- 造一张"动态照片" ------------------------------- */
// 结构：一张 30MB 的"照片"，末尾追加 [ftyp 框][mdat 框][500B 私有尾数据]
const be32 = (n) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const ftyp = new Uint8Array(32);                     // 32 字节的 ftyp 框
ftyp.set([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70], 0); // size=32 + 'ftyp'
ftyp.set([0x69, 0x73, 0x6f, 0x6d], 8);               // 'isom'
const mdatSize = 1_200_000;
const mdat = new Uint8Array(8 + mdatSize);
mdat.set(be32(8 + mdatSize), 0);
mdat.set([0x6d, 0x64, 0x61, 0x74], 4);               // 'mdat'
for (let i = 8; i < mdat.length; i++) mdat[i] = i & 255;
const clip = new Uint8Array(ftyp.length + mdat.length);
clip.set(ftyp, 0);
clip.set(mdat, ftyp.length);
const trailer = new Uint8Array(500).fill(0xff);      // 厂商私有尾数据（要被裁掉）

const photoUri = 'file:///storage/emulated/0/DCIM/IMG_LIVE.jpg';
const photo = new Uint8Array(30 * MB);
for (let i = 0; i < photo.length; i++) photo[i] = 0x11;   // 普通照片数据（拿不到也没关系）
photo.set(clip, photo.length - clip.length - trailer.length);
photo.set(trailer, photo.length - trailer.length);
files.set(photoUri, photo);

const { extractMotionVideo, clearMotionVideoCache } = await import(pathToFileURL(livePhotoPath).href);
const DOC = 'file:///data/user/0/com.example/files/';
const entry = { uri: photoUri, assetId: 'srv-live-1' };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const lastWrite = () => writes[writes.length - 1];
const writtenBytes = () => files.get(lastWrite()?.uri);

// ① + ② XMP 给了长度（真实场景最常见）：只读那一段，写出干净的 mp4
const dest = await extractMotionVideo(entry, { live: true, videoLength: clip.length + trailer.length });
if (!dest || !dest.startsWith(`${DOC}motionVideos/`)) fail.push(`提取结果应落在 motionVideos 目录，实际 ${dest}`);
if (!same(writtenBytes() || new Uint8Array(), clip)) fail.push('写出的 mp4 内容不对（应当正好是 ftyp+mdat，且不含私有尾数据）');
if (bytesRead > 2 * MB) fail.push(`读取量应当只有动效那一段（<2MB），实际 ${(bytesRead / MB).toFixed(2)}MB（整文件是 30MB）`);
if (!lastWrite() || lastWrite().length !== clip.length) fail.push(`写出的字节数应等于 ${clip.length}，实际 ${lastWrite()?.length}`);
const readWithLength = bytesRead;

// ③ 第二次：纯内存命中，零文件 IO
const readsBefore = reads.length;
const dest2 = await extractMotionVideo(entry, { live: true, videoLength: clip.length + trailer.length });
if (dest2 !== dest) fail.push('第二次提取应当直接返回同一个地址');
if (reads.length !== readsBefore) fail.push(`第二次点播放不该再读文件，实际多读了 ${reads.length - readsBefore} 次`);

// ④ 清掉内存缓存后（= 进后台清空目录那条路径）会重新提取
clearMotionVideoCache();
files.delete(dest);
globalThis.__rcNewFS.resetReads();
const dest3 = await extractMotionVideo(entry, { live: true, videoLength: clip.length + trailer.length });
if (!dest3 || !same(writtenBytes() || new Uint8Array(), clip)) fail.push('清缓存后重新提取应当拿到同样的内容');
if (bytesRead === 0) fail.push('清缓存后应当真的重新读一次文件');

// ⑤ 没有 videoLength 标记：靠尾部窗口扫 ftyp 也能取到同一段
globalThis.__rcNewFS.resetReads();
files.delete(dest3);
const dest4 = await extractMotionVideo({ uri: photoUri, assetId: 'srv-live-2' }, { live: true });
if (!dest4 || !same(writtenBytes() || new Uint8Array(), clip)) fail.push('没有 videoLength 时没能靠尾部扫描提取出动效');
if (bytesRead > 2 * MB) fail.push(`没有 videoLength 时读取量应当只有尾部窗口（<2MB），实际 ${(bytesRead / MB).toFixed(2)}MB`);
const readWithoutLength = bytesRead;

// ⑥ 不是实况的照片：不该写出任何文件
const plainUri = 'file:///storage/emulated/0/DCIM/IMG_PLAIN.jpg';
files.set(plainUri, new Uint8Array(6 * MB).fill(0x22));
globalThis.__rcNewFS.resetReads();
const writesBefore = writes.length;
const none = await extractMotionVideo({ uri: plainUri, assetId: 'srv-plain' }, { live: true });
if (none !== null) fail.push('普通照片不该提取出东西');
if (writes.length !== writesBefore) fail.push('普通照片不该写出文件');

console.log(`30MB 大图 + 1.2MB 动效：按 XMP 长度只读 ${(readWithLength / MB).toFixed(2)}MB、没长度标记时读 ${(readWithoutLength / MB).toFixed(2)}MB（整文件 30MB，旧实现要读 30MB）`);
console.log(`第二次调用：0 次文件读取（内存命中）；清缓存后会重新提取；无长度标记时靠尾部扫描也能取出`);
if (fail.length) {
  console.error('✗ 自检未通过：\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log('✓ 通过：提取只读文件尾、写出干净的 mp4、第二次零 IO、清缓存后重提取、普通照片不误判');
