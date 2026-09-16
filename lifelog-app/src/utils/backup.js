// 备份导出/导入：把全部记录写成 JSON 文件备份，或从备份文件恢复/迁入。
// - 导出：走 SAF 文件夹选择器，用户选一个文件夹，写入 lifelog-backup-<时间戳>.json
// - 导入：系统文件选择器直接挑一份备份 JSON，所见即所得，不依赖备份放在哪个文件夹
// - 封面文件（豆瓣海报等本地文件）以 base64 随备份带走，换机恢复后无需重新搜索下载；
//   老备份没有 covers 字段也能正常导入（缺失封面交给回填机制兜底）
// 备份里的媒体条目带着相册指纹（文件名/大小/尺寸），换机导入后跑一次"同步相册影像"即可重新关联。
import * as FileSystem from 'expo-file-system/legacy';

const { StorageAccessFramework } = FileSystem;

const BACKUP_NAME_PREFIX = 'lifelog-backup-';
const COVERS_DIR = `${FileSystem.documentDirectory}covers`;

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

// 收集所有记录引用的本地封面文件（豆瓣封面 + 自选封面小图），读成 base64 随备份导出
const collectCovers = async (logData) => {
  const covers = {};
  for (const log of logData) {
    for (const field of ['coverUrl', 'coverThumbUrl']) {
      const url = log?.[field];
      if (typeof url !== 'string' || !url.startsWith('file://')) continue;
      const base = url.split('/').pop();
      if (!base || covers[base]) continue;
      try {
        const info = await FileSystem.getInfoAsync(url);
        if (!info.exists) continue;
        covers[base] = await FileSystem.readAsStringAsync(url, { encoding: FileSystem.EncodingType.Base64 });
      } catch {}
    }
  }
  return covers;
};

export const exportBackup = async (logData) => {
  try {
    const perms = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms.granted) return { ok: false, canceled: true };

    const now = new Date();
    const name = `${BACKUP_NAME_PREFIX}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
    const covers = await collectCovers(logData);
    const payload = JSON.stringify({
      app: 'lifelog',
      schema: 2,
      exportedAt: now.toISOString(),
      count: logData.length,
      logs: logData,
      ...(Object.keys(covers).length ? { covers } : {}),
    });

    const fileUri = await StorageAccessFramework.createFileAsync(
      perms.directoryUri, name, 'application/json'
    );
    await FileSystem.writeAsStringAsync(fileUri, payload, { encoding: FileSystem.EncodingType.UTF8 });
    return { ok: true, count: logData.length, covers: Object.keys(covers).length, name };
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

    // 封面文件还原：备份里的 base64 写回本地 covers 目录，并把记录的 coverUrl / coverThumbUrl
    // 指向新文件。缺 covers 字段（老备份）或对应文件缺失的记录保持原样，交给回填机制兜底
    const covers = payload?.covers && typeof payload.covers === 'object' ? payload.covers : {};
    let coversRestored = 0;
    const restoredLogs = [];
    for (const log of logs) {
      const restoredLog = { ...log };
      for (const field of ['coverUrl', 'coverThumbUrl']) {
        const url = restoredLog[field];
        if (typeof url !== 'string' || !url.startsWith('file://')) continue;
        const base = url.split('/').pop();
        const b64 = base ? covers[base] : null;
        if (typeof b64 !== 'string' || b64.length === 0) continue;
        try {
          if (!(await FileSystem.getInfoAsync(COVERS_DIR)).exists) {
            await FileSystem.makeDirectoryAsync(COVERS_DIR, { intermediates: true });
          }
          const ext = (base.match(/\.(jpe?g|png|webp)$/i) || [])[1] || 'jpg';
          const dest = `${COVERS_DIR}/cover_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
          await FileSystem.writeAsStringAsync(dest, b64, { encoding: FileSystem.EncodingType.Base64 });
          restoredLog[field] = dest;
          coversRestored++;
        } catch {}
      }
      restoredLogs.push(restoredLog);
    }

    return {
      ok: true,
      logs: restoredLogs,
      count: restoredLogs.length,
      coversRestored,
      name: file.name || nameFromUri(file.uri),
      exportedAt: payload.exportedAt || null,
    };
  } catch (e) {
    return { ok: false, canceled: false, error: e?.message || String(e) };
  }
};
