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

// 「数据目录」诊断：根目录、两个目录的文件数与体积、还有一次真实写入测试
export const describeStorageAsync = async () => {
  const lines = [
    IS_EXTERNAL_STORAGE
      ? '数据目录：应用外部目录（Android/data，文件管理器能看到）'
      : '数据目录：内部存储（没有 root 看不到）',
    STORAGE_ROOT,
  ];
  for (const [label, dir] of [['副本 media', MEDIA_DIR], ['封面 covers', COVERS_DIR]]) {
    try {
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) {
        lines.push(`${label}：目录还不存在`);
        continue;
      }
      const names = await FileSystem.readDirectoryAsync(dir);
      let bytes = 0;
      for (const n of names) {
        try {
          const st = await FileSystem.getInfoAsync(`${dir}/${n}`);
          if (st.exists && typeof st.size === 'number') bytes += st.size;
        } catch {}
      }
      lines.push(`${label}：${names.length} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);
    } catch (e) {
      lines.push(`${label}：读取失败（${e?.message || e}）`);
    }
  }
  // 写入测试最能说明问题：目录不存在也会先建，能写出来才算真的能用
  const probe = `${MEDIA_DIR}/.write-test`;
  try {
    await writeFileBase64Async(probe, 'b2s=');   // "ok"
    const st = await FileSystem.getInfoAsync(probe);
    await FileSystem.deleteAsync(probe, { idempotent: true }).catch(() => {});
    lines.push(`写入测试：${st.exists ? '通过' : '失败（文件没写出来）'}`);
  } catch (e) {
    lines.push(`写入测试：失败（${e?.message || e}）`);
  }
  return lines.join('\n');
};
