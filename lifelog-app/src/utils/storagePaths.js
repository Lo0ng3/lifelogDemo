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

const externalFilesDir = (() => {
  try {
    const dir = requireOptionalNativeModule('Paths')?.getExternalFilesDir?.();
    return dir ? `file://${dir}/` : null;
  } catch {
    return null;
  }
})();

// 带 file:// 前缀、以 / 结尾
export const STORAGE_ROOT = externalFilesDir || FileSystem.documentDirectory;
// 是否真的落在 Android/data 下（排查用）
export const IS_EXTERNAL_STORAGE = !!externalFilesDir;

// 分享进来的副本 / 旧数据迁移副本（重链回相册原片后会被删掉）
export const MEDIA_DIR = `${STORAGE_ROOT}media`;
// 封面小图（网络海报、自选封面）
export const COVERS_DIR = `${STORAGE_ROOT}covers`;
