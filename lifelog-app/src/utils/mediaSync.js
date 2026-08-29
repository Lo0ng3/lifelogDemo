// 相册同步：把记录里的媒体引用重新关联到相册中的原片。
// 原理：扫描整个相册建一张"文件名 -> 相册资产"的 hash 索引，然后逐条检查记录里的媒体条目：
//   1. assetId 还能对上相册 → 不动；
//   2. 条目存了原始文件名（新版本挑选时记录）→ 按文件名匹配，多候选时再按文件大小甄别；
//   3. 只有大小/尺寸指纹（旧缓存迁移出来的条目）→ 按媒体类型 + 尺寸缩小候选，再按大小甄别；
//   4. 都匹配不上 → 记为"无法自动恢复"，由用户在对应记录里重新添加。
// 依赖的指纹（filename/size/w/h）在挑选媒体时（AddScreen.pickImage）和旧数据迁移时写入记录。
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { normalizeMediaEntry, isVideoEntry } from './media';

const PAGE_SIZE = 500;

// 只申请照片和视频权限（与 resolveMediaUri 一致，避免 AUDIO 权限缺失导致报错）
const ensurePermission = async () => {
  let perm = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
  if (!perm.granted) {
    perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
  }
  return perm.granted;
};

// 分页扫全相册，只取元数据（文件名/宽高/类型），不碰文件内容
const scanGallery = async () => {
  const assets = [];
  for (const mediaType of ['photo', 'video']) {
    let after;
    let hasNext = true;
    while (hasNext) {
      const page = await MediaLibrary.getAssetsAsync({ first: PAGE_SIZE, after, mediaType });
      assets.push(...page.assets);
      hasNext = page.hasNextPage;
      after = page.endCursor;
    }
  }
  return assets;
};

// 相册资产的实际文件大小（MediaLibrary 元数据里没有，需要读原文件 stat），带缓存避免重复读
const makeStatCache = () => {
  const cache = new Map();
  return async (asset) => {
    if (cache.has(asset.id)) return cache.get(asset.id);
    let out = null;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset.id);
      const target = info?.localUri || asset.uri;
      if (target) {
        const stat = await FileSystem.getInfoAsync(target);
        if (stat.exists && typeof stat.size === 'number' && stat.size >= 0) {
          out = { size: stat.size, localUri: target };
        }
      }
    } catch {}
    cache.set(asset.id, out);
    return out;
  };
};

export const syncMediaFromGallery = async (logs) => {
  if (!(await ensurePermission())) {
    return { permissionDenied: true, changed: false, logs, matched: 0, unmatched: [] };
  }

  const assets = await scanGallery();
  const statAsset = makeStatCache();

  const byId = new Map(assets.map(a => [a.id, a]));
  // hash 索引：文件名 -> 资产列表（相册里可能存在重名文件，保留列表按大小甄别）
  const byName = new Map();
  assets.forEach(a => {
    if (!a.filename) return;
    const list = byName.get(a.filename) || [];
    list.push(a);
    byName.set(a.filename, list);
  });

  // 条目是否真的断链：assetId 已不在相册，或备用 URI 指向的文件已丢失
  const needsRelink = async (entry) => {
    if (entry.assetId) return !byId.has(entry.assetId);
    const uri = entry.uri;
    if (!uri || !uri.startsWith('file://')) return false; // 网络图等无需处理
    try {
      return !(await FileSystem.getInfoAsync(uri)).exists;
    } catch {
      return false;
    }
  };

  // 从候选里挑出与指纹吻合的那个；size 是最强指纹，对不上就不勉强关联
  const pickCandidate = async (candidates, entry) => {
    if (!candidates.length) return null;
    if (!entry.size) return entry.w ? null : candidates[0];
    for (const c of candidates) {
      const stat = await statAsset(c);
      if (stat && stat.size === entry.size) return { ...c, localUri: stat.localUri };
    }
    return null;
  };

  let changed = false;
  let matched = 0;
  const unmatchedLogs = new Set();

  const next = await Promise.all((logs || []).map(async (log) => {
    if (!Array.isArray(log.localImages) || log.localImages.length === 0) return log;
    let logChanged = false;
    let logUnmatched = false;

    const entries = await Promise.all(log.localImages.map(async (raw) => {
      const entry = normalizeMediaEntry(raw);
      if (!entry || !(await needsRelink(entry))) return raw;

      const mediaType = isVideoEntry(entry) ? 'video' : 'photo';
      let hit = null;

      // 1) 按文件名匹配（挑选时保存的相册原始文件名）
      if (entry.filename && byName.has(entry.filename)) {
        const candidates = byName.get(entry.filename).filter(a => a.mediaType === mediaType);
        hit = await pickCandidate(candidates, entry);
      }

      // 2) 只有大小/尺寸指纹（旧缓存迁移出的条目）：按类型 + 尺寸缩小范围后按大小甄别
      if (!hit && entry.size && !entry.filename) {
        let candidates = assets.filter(a => a.mediaType === mediaType);
        if (entry.w && entry.h) {
          candidates = candidates.filter(a => a.width === entry.w && a.height === entry.h);
        }
        hit = await pickCandidate(candidates, entry);
      }

      if (!hit) {
        logUnmatched = true;
        return raw;
      }

      matched++;
      logChanged = true;
      return {
        ...entry,
        uri: hit.localUri || hit.uri || entry.uri,
        assetId: hit.id,
        filename: hit.filename || entry.filename || null,
        size: entry.size || null,
        w: entry.w || hit.width || null,
        h: entry.h || hit.height || null,
        ratio: entry.ratio || (hit.width && hit.height ? hit.width / hit.height : null),
      };
    }));

    if (logUnmatched) unmatchedLogs.add({ id: log.id, title: log.title });
    if (!logChanged) return log;
    changed = true;
    return { ...log, localImages: entries };
  }));

  return { permissionDenied: false, changed, logs: changed ? next : logs, matched, unmatched: [...unmatchedLogs] };
};
