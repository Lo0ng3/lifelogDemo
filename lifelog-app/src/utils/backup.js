// 备份导出/导入：把全部记录写成 JSON 文件备份，或从备份文件恢复/迁入。
// 使用 Android 的 SAF（Storage Access Framework）文件夹选择器，不依赖额外原生模块：
// - 导出：用户选一个文件夹，写入 lifelog-backup-<时间戳>.json
// - 导入：用户选备份所在的文件夹，自动扫描其中的 lifelog-backup-*.json 并取最新一份
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

// 读取用户选定文件夹里最新的备份文件，只解析不落库，返回给上层做覆盖/合并的确认
export const importBackup = async () => {
  try {
    const perms = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms.granted) return { ok: false, canceled: true };

    const entries = await StorageAccessFramework.readDirectoryAsync(perms.directoryUri);
    const backups = entries
      .map(uri => ({ uri, name: nameFromUri(uri) }))
      .filter(({ name }) => name.startsWith(BACKUP_NAME_PREFIX) && name.endsWith('.json'))
      .sort((a, b) => b.name.localeCompare(a.name)); // 文件名带时间戳，字典序即时间序

    if (backups.length === 0) {
      return { ok: false, notFound: true };
    }

    const latest = backups[0];
    const content = await FileSystem.readAsStringAsync(latest.uri, { encoding: FileSystem.EncodingType.UTF8 });
    const payload = JSON.parse(content);
    const logs = Array.isArray(payload?.logs)
      ? payload.logs.filter(l => l && l.id != null && l.date)
      : null;
    if (!logs) return { ok: false, invalid: true };

    return {
      ok: true,
      logs,
      count: logs.length,
      name: latest.name,
      exportedAt: payload.exportedAt || null,
      backupCount: backups.length, // 同文件夹里还有更早的备份时提示一下
    };
  } catch (e) {
    return { ok: false, canceled: false, error: e?.message || String(e) };
  }
};
