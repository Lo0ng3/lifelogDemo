// 备份导出/导入：把全部记录写成 JSON 文件备份，或从备份文件恢复/迁入。
// - 导出：Android 走 SAF 文件夹选择器；iOS 写入临时文件后唤起系统分享面板（可存储到「文件」/ AirDrop / iCloud）
// - 导入：系统文件选择器直接挑一份备份 JSON，所见即所得，不依赖备份放在哪个文件夹
// - 封面文件（豆瓣海报等本地文件）以 base64 随备份带走，换机恢复后无需重新搜索下载；
//   老备份没有 covers 字段也能正常导入（缺失封面交给回填机制兜底）
// 备份里的媒体条目带着相册指纹（文件名/大小/尺寸），换机导入后跑一次"同步相册影像"即可重新关联。
import { Platform, Share } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { COVERS_DIR, ensureDirAsync, writeFileBase64Async } from './storagePaths';

const { StorageAccessFramework } = FileSystem;

const BACKUP_NAME_PREFIX = 'lifelog-backup-';

const pad = (n) => String(n).padStart(2, '0');

// 地图 Key 是整机设置，跟着备份走：导出时带上，导入时覆盖本机
const pickKeys = (keys) => {
  if (!keys || typeof keys !== 'object') return null;
  const out = {};
  for (const k of ['tdtKey', 'amapKey', 'amapJsKey', 'amapJsCode']) {
    if (typeof keys[k] === 'string' && keys[k]) out[k] = keys[k];
  }
  if (keys.mapProvider === 'amap' || keys.mapProvider === 'tianditu') out.mapProvider = keys.mapProvider;
  return Object.keys(out).length ? out : null;
};

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

const collectProfile = async (profile) => {
  if (!profile) return null;
  const out = { name: String(profile.name || '').trim() };
  if (profile.avatarUri?.startsWith('file://')) {
    try {
      const info = await FileSystem.getInfoAsync(profile.avatarUri);
      if (info.exists) {
        out.avatar = {
          ext: (profile.avatarUri.match(/\.(jpe?g|png|webp)$/i) || [])[1] || 'jpg',
          base64: await FileSystem.readAsStringAsync(profile.avatarUri, { encoding: FileSystem.EncodingType.Base64 }),
        };
      }
    } catch {}
  }
  return (out.name || out.avatar) ? out : null;
};

const collectVideoPosters = async (logData) => {
  const posters = {};
  for (const log of logData) {
    for (const entry of log?.localImages || []) {
      const poster = entry?.videoPoster;
      if (!poster) continue;
      if (poster.uri?.startsWith('file://')) {
        const base = poster.uri.split('/').pop();
        if (!base || posters[base]) continue;
        try {
          const info = await FileSystem.getInfoAsync(poster.uri);
          if (!info.exists) continue;
          posters[base] = await FileSystem.readAsStringAsync(poster.uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
        } catch {}
      }
    }
  }
  return posters;
};

// 内部快照和手动导出共用同一个 payload 构造，字段不会各写一套。
export const buildBackupPayload = async ({
  logData,
  keys = null,
  profile = null,
  exportedAt = new Date().toISOString(),
}) => {
  const covers = await collectCovers(logData);
  const videoPosters = await collectVideoPosters(logData);
  const keyPayload = pickKeys(keys);
  const profilePayload = await collectProfile(profile);
  return {
    payload: {
      app: 'lifelog',
      schema: 4,
      exportedAt,
      count: logData.length,
      logs: logData,
      ...(Object.keys(covers).length ? { covers } : {}),
      ...(Object.keys(videoPosters).length ? { videoPosters } : {}),
      ...(keyPayload ? { keys: keyPayload } : {}),
      ...(profilePayload ? { profile: profilePayload } : {}),
    },
    coversCount: Object.keys(covers).length,
    postersCount: Object.keys(videoPosters).length,
    hasKeys: !!keyPayload,
    hasProfile: !!profilePayload,
  };
};

const INTERNAL_BACKUP_DIR = `${FileSystem.documentDirectory}internal-backup`;
const INTERNAL_BACKUP_FILE = `${INTERNAL_BACKUP_DIR}/lifelog-latest.json`;

// 内部备份：和手动备份使用同一份 payload，先写临时文件再替换。
export const writeInternalBackup = async ({ logData, keys, profile }) => {
  await FileSystem.makeDirectoryAsync(INTERNAL_BACKUP_DIR, { intermediates: true });
  const built = await buildBackupPayload({ logData, keys, profile });
  const text = JSON.stringify(built.payload);
  const tmp = `${INTERNAL_BACKUP_DIR}/lifelog-latest.tmp.json`;
  await FileSystem.writeAsStringAsync(tmp, text, { encoding: FileSystem.EncodingType.UTF8 });
  try {
    await FileSystem.moveAsync({ from: tmp, to: INTERNAL_BACKUP_FILE });
  } catch {
    // 有些平台的 move 不覆盖已有目标：先删旧快照，再把刚写成功的临时文件换上去
    try { await FileSystem.deleteAsync(INTERNAL_BACKUP_FILE, { idempotent: true }); } catch {}
    await FileSystem.moveAsync({ from: tmp, to: INTERNAL_BACKUP_FILE });
  }
  return built;
};

export const exportBackup = async (logData, keys = null, profile = null) => {
  try {
    const now = new Date();
    const name = `${BACKUP_NAME_PREFIX}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;

    if (Platform.OS === 'ios') {
      const built = await buildBackupPayload({
        logData,
        keys,
        profile,
        exportedAt: now.toISOString(),
      });
      const payload = JSON.stringify(built.payload);
      const exportDir = `${FileSystem.cacheDirectory}backups`;
      // 每次导出前清掉上一次留下的临时备份文件，避免缓存越积越多
      try { await FileSystem.deleteAsync(exportDir, { idempotent: true }); } catch {}
      await FileSystem.makeDirectoryAsync(exportDir, { intermediates: true });
      const tmpFile = `${exportDir}/${name}`;
      await FileSystem.writeAsStringAsync(tmpFile, payload, { encoding: FileSystem.EncodingType.UTF8 });
      const res = await Share.share({ url: tmpFile, title: name });
      if (res?.action === Share.dismissedAction) return { ok: false, canceled: true };
      return {
        ok: true,
        count: logData.length,
        covers: built.coversCount,
        videoPosters: built.postersCount,
        keys: built.hasKeys,
        profile: built.hasProfile,
        name,
      };
    }

    const perms = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms.granted) return { ok: false, canceled: true };

    const built = await buildBackupPayload({
      logData,
      keys,
      profile,
      exportedAt: now.toISOString(),
    });
    const payload = JSON.stringify(built.payload);

    const fileUri = await StorageAccessFramework.createFileAsync(
      perms.directoryUri, name, 'application/json'
    );
    await FileSystem.writeAsStringAsync(fileUri, payload, { encoding: FileSystem.EncodingType.UTF8 });
    return {
      ok: true,
      count: logData.length,
      covers: built.coversCount,
      videoPosters: built.postersCount,
      keys: built.hasKeys,
      profile: built.hasProfile,
      name,
    };
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
    const picked = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets?.length) return { ok: false, canceled: true };

    const file = picked.assets[0];
    const content = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.UTF8 });
    if (FileSystem.cacheDirectory && file.uri?.startsWith(FileSystem.cacheDirectory)) {
      FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => {});
    }
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
          await ensureDirAsync(COVERS_DIR);
          const ext = (base.match(/\.(jpe?g|png|webp)$/i) || [])[1] || 'jpg';
          const dest = `${COVERS_DIR}/cover_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
          await writeFileBase64Async(dest, b64);
          restoredLog[field] = dest;
          coversRestored++;
        } catch {}
      }
      restoredLogs.push(restoredLog);
    }

    // 视频方格封面：备份里是 base64，恢复到持久 poster 目录，记录仍只存路径
    const posterSources = payload?.videoPosters && typeof payload.videoPosters === 'object'
      ? payload.videoPosters
      : {};
    const posterDir = `${FileSystem.documentDirectory}videoPosters`;
    const posterDestByBase = new Map();
    const restoredPosterLogs = [];
    let postersRestored = 0;
    for (const log of restoredLogs) {
      if (!Array.isArray(log.localImages) || log.localImages.length === 0) {
        restoredPosterLogs.push(log);
        continue;
      }
      let changed = false;
      const nextImages = [];
      for (const entry of log.localImages) {
        const poster = entry?.videoPoster;
        if (!poster) {
          nextImages.push(entry);
          continue;
        }
        const base = poster.uri?.startsWith('file://') ? poster.uri.split('/').pop() : null;
        const b64 = (base && posterSources[base]) || poster.base64 || null;
        if (!b64) {
          nextImages.push(entry);
          continue;
        }
        let dest = base ? posterDestByBase.get(base) : null;
        try {
          if (!dest) {
            await FileSystem.makeDirectoryAsync(posterDir, { intermediates: true });
            const ext = String(poster.mime || 'image/jpeg').includes('png') ? 'png' : 'jpg';
            dest = `${posterDir}/poster_import_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
            await writeFileBase64Async(dest, b64);
            if (base) posterDestByBase.set(base, dest);
          }
          const posterMeta = { ...poster };
          delete posterMeta.base64;
          nextImages.push({ ...entry, videoPoster: { ...posterMeta, uri: dest } });
          postersRestored++;
          changed = true;
        } catch {
          nextImages.push(entry);
        }
      }
      restoredPosterLogs.push(changed ? { ...log, localImages: nextImages } : log);
    }

    // 头像和名字也跟着备份走：头像以 base64 写入，导入时落到应用目录
    let restoredProfile = null;
    if (payload?.profile) {
      const raw = payload.profile;
      let avatarUri = null;
      if (raw.avatar?.base64) {
        try {
          const dir = `${FileSystem.documentDirectory}profile`;
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
          const ext = String(raw.avatar.ext || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
          const dest = `${dir}/avatar_import_${Date.now()}.${ext}`;
          await writeFileBase64Async(dest, raw.avatar.base64);
          avatarUri = dest;
        } catch {}
      }
      const name = String(raw.name || '').trim();
      if (name || avatarUri) restoredProfile = { name: name || null, avatarUri };
    }

    return {
      ok: true,
      logs: restoredPosterLogs,
      count: restoredPosterLogs.length,
      coversRestored,
      postersRestored,
      keys: pickKeys(payload?.keys),
      profile: restoredProfile,
      name: file.name || nameFromUri(file.uri),
      exportedAt: payload.exportedAt || null,
    };
  } catch (e) {
    return { ok: false, canceled: false, error: e?.message || String(e) };
  }
};
