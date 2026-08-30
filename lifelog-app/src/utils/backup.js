// 备份导出/导入：把全部记录写成 JSON 文件备份，或从备份文件恢复/迁入。
// - 导出：走 SAF 文件夹选择器，用户选一个文件夹，写入 lifelog-backup-<时间戳>.json
// - 导入：系统文件选择器直接挑一份备份 JSON，所见即所得，不依赖备份放在哪个文件夹
// 备份里的媒体条目带着相册指纹（文件名/大小/尺寸），换机导入后跑一次"同步相册影像"即可重新关联。
import * as FileSystem from 'expo-file-system/legacy';

const { StorageAccessFramework } = FileSystem;

const BACKUP_NAME_PREFIX = 'lifelog-backup-';

const pad = (n) => String(n).padStart(2, '0');

// 从 SAF 的 content:// URI 里抠出文件名（URI 末段形如 Primary%3ADownload%2Flifelog-backup-x.json）
const nameFromUri = (uri) => {
  try {
    const decoded = decodeURIComponent(uri);
    return decoded.split(/[:/]/).pop() || decoded;
  } catch {
    return uri;
  }
};

export const exportBackup = async (logData) => {
  try {
    const perms = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms.granted) return { ok: false, canceled: true };

    const now = new Date();
    const name = `${BACKUP_NAME_PREFIX}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
    const payload = JSON.stringify({
      app: 'lifelog',
      schema: 1,
      exportedAt: now.toISOString(),
      count: logData.length,
      logs: logData,
    });

    const fileUri = await StorageAccessFramework.createFileAsync(
      perms.directoryUri, name, 'application/json'
    );
    await FileSystem.writeAsStringAsync(fileUri, payload, { encoding: FileSystem.EncodingType.UTF8 });
    return { ok: true, count: logData.length, name };
  } catch (e) {
    return { ok: false, canceled: false, error: e?.message || String(e) };
  }
};

// 文件选择器挑一份备份，只解析不落库，返回给上层做覆盖/合并的确认
export const importBackup = async () => {
  try {
    // 顶层 import 会在应用启动时加载原生模块，旧开发构建没有该模块会直接崩，
    // 改为用到时才加载，缺失时给出明确提示而不是红屏
    let DocumentPicker;
    try {
      DocumentPicker = require('expo-document-picker');
    } catch {
      return { ok: false, error: '当前安装的版本未包含文件选择模块，请使用最新打包的正式版。' };
    }
    // 不按 MIME 过滤：部分机型的文件管理器会把 .json 标成 application/octet-stream，
    // 过滤严了反而选不到备份文件，合法性交给内容校验
    const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false });
    if (picked.canceled || !picked.assets?.length) return { ok: false, canceled: true };

    const file = picked.assets[0];
    const content = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.UTF8 });
    const payload = JSON.parse(content);
    const logs = Array.isArray(payload?.logs)
      ? payload.logs.filter(l => l && l.id != null && l.date)
      : null;
    if (!logs) return { ok: false, invalid: true };

    return {
      ok: true,
      logs,
      count: logs.length,
      name: file.name || nameFromUri(file.uri),
      exportedAt: payload.exportedAt || null,
    };
  } catch (e) {
    return { ok: false, canceled: false, error: e?.message || String(e) };
  }
};
