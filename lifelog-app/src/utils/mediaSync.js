// 相册同步与媒体重链：把记录里的媒体条目关联到相册中的原片，App 内不长期持有副本。
// 原理：扫描整个相册建一张索引（id / 文件名 → 相册资产），然后逐条检查记录里的媒体条目：
//   1. assetId 还能对上相册、备用路径也活着 → 不动；
//   2. 备用路径是应用私有副本（选图器缓存 / 旧迁移副本）→ 换成相册引用并删掉副本；
//   3. 条目断链（assetId 失效或备用文件丢失）→ 按文件名 + 大小 + 尺寸指纹重新关联；
//   4. 都匹配不上且确实无法显示 → 记为"无法自动恢复"，由用户在对应记录里重新添加。
// 依赖的指纹（filename/size/w/h）在挑选媒体时（AddScreen.pickImage）和旧数据迁移时写入记录。
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import {
  normalizeMediaEntry, isVideoEntry, isAppOwnedMediaPath, hasGalleryAccess,
  pruneOrphanMediaCopies, pruneOrphanCovers, referencedMediaNames, entriesMediaNames, mediaNameOfUri,
} from './media';
import { deletePathAsync } from './storagePaths';

const PAGE_SIZE = 500;
// 单个条目最多核对的候选数量：文件大小要逐个 getAssetInfoAsync 读，候选太多时截断避免卡死。
// 保存时用小额度（保持保存流畅），手动同步用大额度（用户有进度提示，可等）
const QUICK_STAT_CHECKS = 120;
const THOROUGH_STAT_CHECKS = 600;
// 一次索引生命周期内最多读取的文件大小次数（getAssetInfoAsync 较慢），
// 超出后放弃需要大小核对的匹配，等下一次同步再试，避免一次扫描卡几分钟
const MAX_TOTAL_STATS = 3000;
// 相册索引缓存有效期：保存记录时的静默重链直接复用，超时后重新扫描
const INDEX_TTL = 5 * 60 * 1000;

// 只申请照片和视频权限（与 resolveMediaUri 一致，避免 AUDIO 权限缺失导致报错），
// 返回完整的权限状态供上层诊断展示
const ensurePermission = async () => {
  let perm = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
  if (!hasGalleryAccess(perm)) {
    perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
  }
  return perm;
};

// 分页扫全相册，只取元数据（文件名/宽高/类型），不碰文件内容。
// 按创建时间倒序：刚拍/刚截的图永远排最前，尺寸指纹核对时最先被查到
const scanGallery = async () => {
  const assets = [];
  for (const mediaType of ['photo', 'video']) {
    let after;
    let hasNext = true;
    while (hasNext) {
      const page = await MediaLibrary.getAssetsAsync({
        first: PAGE_SIZE,
        after,
        mediaType,
        sortBy: [['creationTime', false]],
      });
      assets.push(...page.assets);
      hasNext = page.hasNextPage;
      after = page.endCursor;
      // 每页之间让出一拍：一页 500 条会占住 JS 线程一小会儿，
      // 连续拉几十页就是滚动时那种"一顿一顿"的来源（让出去后动画/手势能插进来）
      if (hasNext) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return assets;
};

// 相册资产的实际文件大小：直接 stat 相册给的文件路径（getAssetInfoAsync 在部分设备上
// 会因 ACCESS_MEDIA_LOCATION 缺失被拒，不能依赖它），带缓存避免重复读。
// 读取次数有总预算：超大相册 + 大量无文件名指纹的旧记录时，防止一次同步跑上几分钟
const makeStatCache = () => {
  const cache = new Map();
  let calls = 0;
  return async (asset) => {
    if (cache.has(asset.id)) return cache.get(asset.id);
    if (calls >= MAX_TOTAL_STATS) return null;
    calls++;
    let out = null;
    try {
      const target = asset.uri;
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

let galleryIndex = null;
let galleryIndexPromise = null;

// 相册索引：全量资产 + id/文件名（小写键，兼容换机后大小写变化）索引 + 大小读取缓存
// sizeMaps：按"类型+尺寸"缓存的 文件大小→资产 映射，同组条目共享一次统计开销
const buildIndex = async () => {
  const assets = await scanGallery();
  const byId = new Map(assets.map(a => [a.id, a]));
  const byName = new Map();
  assets.forEach(a => {
    if (!a.filename) return;
    const key = a.filename.toLowerCase();
    const list = byName.get(key) || [];
    list.push(a);
    byName.set(key, list);
  });
  galleryIndex = { assets, byId, byName, statAsset: makeStatCache(), sizeMaps: new Map(), builtAt: Date.now() };
  return galleryIndex;
};

export const getGalleryIndex = async (force = false) => {
  if (!force && galleryIndex && Date.now() - galleryIndex.builtAt < INDEX_TTL) return galleryIndex;
  if (!galleryIndexPromise) {
    galleryIndexPromise = buildIndex().finally(() => { galleryIndexPromise = null; });
  }
  return galleryIndexPromise;
};

// 启动时静默预热：不弹权限窗，已授权就把索引建好，保存记录时的重链就是纯内存查找
export const warmGalleryIndex = async () => {
  try {
    if (!hasGalleryAccess(await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']))) return;
    await getGalleryIndex(false);
  } catch {}
};

// 条目是否需要重链：引用失效（assetId 不在相册 / 备用文件已丢失），
// 或备用路径是应用私有副本（副本应换成相册引用，App 里不留原件拷贝）
const needsRelink = async (entry, index) => {
  const { assetId, uri } = entry;
  if (assetId) {
    if (!index.byId.has(assetId)) return true;
    if (!uri || !uri.startsWith('file://')) return false;
    if (isAppOwnedMediaPath(uri)) return true;
    try {
      return !(await FileSystem.getInfoAsync(uri)).exists;
    } catch {
      return false;
    }
  }
  if (!uri || !uri.startsWith('file://')) return false; // 网络图等无需处理
  if (isAppOwnedMediaPath(uri)) return true;
  try {
    return !(await FileSystem.getInfoAsync(uri)).exists;
  } catch {
    return false;
  }
};

// 挑出与指纹最吻合的相册资产；拿不准就不关联（错关联比不关联更糟）。
// 文件名是最强指纹，文件大小次之，图片宽高做辅助；
// 换机后文件名可能改变，此时退回"类型 + 尺寸 + 文件大小"指纹。
// statCap 控制一次大小索引最多统计多少资产（保存时小、同步时大），索引建好后同组条目共享
const matchAssetForEntry = async (entry, mediaType, index, statCap) => {
  const { byName, assets, statAsset } = index;
  // 优先用 getAssetInfoAsync 的本地路径（跨平台都指向可读的原片文件），拿不到再退回资产 uri
  const wrap = async (c) => {
    const stat = await statAsset(c);
    return { ...c, localUri: stat?.localUri || c.uri };
  };

  // 1) 文件名圈定候选（挑选时记录的相册原始文件名）
  let candidates = [];
  if (entry.filename) {
    candidates = (byName.get(entry.filename.toLowerCase()) || []).filter(a => a.mediaType === mediaType);
  }

  // 2) 文件名没圈到候选（改名/拿不到文件名）：退回类型 + 尺寸指纹，必须有文件大小才敢猜。
  //    注意 EXIF 旋转：相册元数据和本机解码出的宽高可能正好互换，两个方向都试。
  //    同一"类型+尺寸"组的 大小→资产 映射建一次全组共享，相册按创建时间倒序、新图最先统计
  if (candidates.length === 0) {
    if (!entry.size) return null;
    let pool = assets.filter(a => a.mediaType === mediaType);
    if (entry.w && entry.h) {
      const dimsMatch = (a) =>
        !a.width || !a.height
          ? false
          : (a.width === entry.w && a.height === entry.h) ||
            (a.width === entry.h && a.height === entry.w);
      const er = entry.ratio || entry.w / entry.h;
      const ratioMatch = (a) => {
        if (!a.width || !a.height || !er) return false;
        const ar = a.width / a.height;
        return Math.abs(ar - er) < 0.02 || Math.abs(ar - 1 / er) < 0.02;
      };
      pool = pool.filter(a => dimsMatch(a) || ratioMatch(a));
    }
    const mapKey = `${mediaType}|${entry.w || 0}x${entry.h || 0}`;
    let sizeMap = index.sizeMaps.get(mapKey);
    if (!sizeMap) {
      sizeMap = new Map();
      for (const c of pool.slice(0, statCap)) {
        const stat = await statAsset(c);
        if (stat && !sizeMap.has(stat.size)) sizeMap.set(stat.size, c);
      }
      index.sizeMaps.set(mapKey, sizeMap);
    }
    const hit = sizeMap.get(entry.size);
    return hit ? wrap(hit) : null;
  }

  candidates = candidates.slice(0, statCap);

  // 没记录文件大小：只在文件名候选里挑，唯一候选直接认，多个候选用宽高收窄到唯一
  if (!entry.size) {
    if (candidates.length === 1) return wrap(candidates[0]);
    if (entry.w && entry.h) {
      const narrowed = candidates.filter(a =>
        (a.width === entry.w && a.height === entry.h) ||
        (a.width === entry.h && a.height === entry.w));
      if (narrowed.length === 1) return wrap(narrowed[0]);
    }
    return null;
  }
  // 有文件大小：逐个核对，大小一致优先；
  // 唯一候选大小不一致也接受（原片在相册里被编辑过 / 选图时指纹取到的是转码后大小），
  // 但图片要宽高对得上才算反证通过（EXIF 旋转下两个方向都算），宽高不符宁可放弃
  let uniqueFallback = null;
  for (const c of candidates) {
    const stat = await statAsset(c);
    if (!stat) continue;
    if (stat.size === entry.size) return { ...c, localUri: stat.localUri };
    if (candidates.length === 1) uniqueFallback = { ...c, localUri: stat.localUri };
  }
  if (uniqueFallback) {
    const dimsOk = mediaType === 'video' || !entry.w || !entry.h ||
      (uniqueFallback.width === entry.w && uniqueFallback.height === entry.h) ||
      (uniqueFallback.width === entry.h && uniqueFallback.height === entry.w);
    if (dimsOk) return uniqueFallback;
  }
  return null;
};

// 匹配成功后的条目改写：指向相册原片，指纹以相册为准补全
const relinkedEntry = (entry, hit) => ({
  ...entry,
  uri: hit.localUri || hit.uri || entry.uri,
  assetId: hit.id,
  filename: hit.filename || entry.filename || null,
  size: entry.size || null,
  w: entry.w || hit.width || null,
  h: entry.h || hit.height || null,
  ratio: entry.ratio || (hit.width && hit.height ? hit.width / hit.height : null),
});

// 条目上所有指向应用私有 media/ 的字符串字段（目前就是主 uri；将来多挂别的
// 字段时也不会漏删）。重链成功后这些副本都该从磁盘上消失
const appOwnedUrisOf = (entry) =>
  Object.values(entry).filter((v) => typeof v === 'string' && isAppOwnedMediaPath(v));

// 对一组媒体条目做重链。
// 返回 matched（重链成功的条数）、replacedUris（被引用替换掉的应用私有副本，调用方负责删除）、
// brokenCount（重链失败且确实无法显示的条数，备用路径还活着的不算）
const relinkEntries = async (rawEntries, index, statCap) => {
  const entries = [];
  const replacedUris = [];
  let matched = 0;
  let brokenCount = 0;

  for (const raw of rawEntries || []) {
    const entry = normalizeMediaEntry(raw);
    if (!entry || !(await needsRelink(entry, index))) {
      entries.push(raw);
      continue;
    }
    // ① 相册引用本身还有效（assetId 在相册里查得到）：记录已经能正常显示原片，
    //    附带的私有副本纯属多余。直接按 assetId 换回相册原片并登记删副本——
    //    不再要求文件名 / 大小指纹也吻合。指纹对不上（分享进来的副本被改过名、
    //    原片在相册里被编辑过…）正是"记录能引用相册、副本却一直清不掉"的原因
    if (entry.assetId && index.byId.has(entry.assetId)) {
      const asset = index.byId.get(entry.assetId);
      const stat = await index.statAsset(asset);
      matched++;
      replacedUris.push(...appOwnedUrisOf(entry));
      entries.push(relinkedEntry(entry, { ...asset, localUri: stat?.localUri || asset.uri }));
      continue;
    }
    const mediaType = isVideoEntry(entry) ? 'video' : 'photo';
    const hit = await matchAssetForEntry(entry, mediaType, index, statCap);
    if (hit) {
      matched++;
      replacedUris.push(...appOwnedUrisOf(entry));
      entries.push(relinkedEntry(entry, hit));
      continue;
    }
    entries.push(raw);
    // 匹配失败后判断是否真的无法显示：assetId 还在相册、或备用文件还在，都还能看
    let fileAlive = true;
    if (entry.uri && entry.uri.startsWith('file://')) {
      try {
        fileAlive = (await FileSystem.getInfoAsync(entry.uri)).exists;
      } catch {
        fileAlive = false;
      }
    }
    if (!(entry.assetId && index.byId.has(entry.assetId)) && !fileAlive) brokenCount++;
  }

  return { entries, replacedUris, matched, brokenCount };
};

// 保存记录时把刚选的媒体换成相册引用（原件留在相册，App 零副本）。
// - 未授权相册时当场请求一次；拒绝过且系统不再允许询问时跳过，副本交给"同步相册影像"兜底；
// - 首轮没匹配上的条目强制重扫一次相册再试：索引可能是启动时预热建的，
//   刚拍的照/刚截的图不在旧索引里——这是新记录仍留副本最常见的原因。
// 返回 keptCount（保存后仍是本地副本的条数）和 reason（没转成引用的原因，供界面提示）
export const relinkNewEntries = async (entries) => {
  const countKept = (es) => (es || []).filter(e => isAppOwnedMediaPath(normalizeMediaEntry(e)?.uri)).length;
  // 快路径：条目都是纯相册引用（应用内选图器产物），没有本地副本要重链，零扫描零权限查询直接返回
  if (countKept(entries) === 0) {
    return { entries, replacedUris: [], matched: 0, keptCount: 0, reason: null };
  }
  try {
    let perm = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
    if (!hasGalleryAccess(perm)) {
      if (!perm?.canAskAgain) {
        return { entries, replacedUris: [], matched: 0, keptCount: countKept(entries), reason: '未获得相册访问权限' };
      }
      perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
      if (!hasGalleryAccess(perm)) {
        return { entries, replacedUris: [], matched: 0, keptCount: countKept(entries), reason: '未获得相册访问权限' };
      }
    }

    let index = await getGalleryIndex(false);
    let result = await relinkEntries(entries, index, QUICK_STAT_CHECKS);

    // 还有副本没换成引用 → 旧索引可能过时，强制重扫再试一轮（已转成引用的条目会自动跳过）。
    // 索引是刚建的就不用重扫了，省一次全量扫描
    const missed = result.entries.filter(e => isAppOwnedMediaPath(normalizeMediaEntry(e)?.uri)).length;
    if (missed > 0 && Date.now() - index.builtAt > 30 * 1000) {
      const fresh = await getGalleryIndex(true);
      if (fresh !== index) {
        result = await relinkEntries(result.entries, fresh, QUICK_STAT_CHECKS);
      }
    }

    const keptCount = countKept(result.entries);
    const firstKept = result.entries.map(normalizeMediaEntry).find(e => e && isAppOwnedMediaPath(e.uri));
    const keptHint = firstKept
      ? `${firstKept.filename || '无文件名'}，${firstKept.size ? Math.round(firstKept.size / 1024) + 'KB' : '大小未知'}`
      : '';
    // 删除前最后一道闸：重链后的条目里还有谁指向这个副本就不删（同一张影像被两个
    // 条目共用时，删掉会让另一个条目断链）
    const keptNames = entriesMediaNames(result.entries);
    return {
      entries: result.entries,
      replacedUris: result.replacedUris.filter((u) => !keptNames.has(mediaNameOfUri(u))),
      matched: result.matched,
      keptCount,
      reason: keptCount > 0 ? `在相册中找不到对应原片：${keptHint}` : null,
    };
  } catch (e) {
    console.warn('[mediaSync] 保存时重链失败，保留副本兜底', e);
    return {
      entries,
      replacedUris: [],
      matched: 0,
      keptCount: countKept(entries),
      reason: `重链出错：${e?.message || e}`,
    };
  }
};

export const syncMediaFromGallery = async (logs, onProgress) => {
  // 先清掉 media/ 里没有任何记录引用的副本（分享后放弃、保存失败、迁移残留…）。
  // 这一步只看记录和 App 自己的目录，不需要相册权限，所以放在最前面，
  // 权限被拒 / 扫描失败时也已经把孤儿文件收干净了
  const pruned = await pruneOrphanMediaCopies(logs)
    .catch(() => ({ removed: 0, freed: 0, scanned: 0, errors: [] }));

  // 权限和扫描各自包一层，失败时把真实原因抛给界面展示，不再只有笼统的"扫描失败"
  let perm;
  try {
    perm = await ensurePermission();
  } catch (e) {
    throw new Error(`查询相册权限状态失败：${e?.message || e}`);
  }
  if (!hasGalleryAccess(perm)) {
    return {
      permissionDenied: true,
      permState: {
        granted: !!perm?.granted,
        accessPrivileges: perm?.accessPrivileges || 'unknown',
        canAskAgain: !!perm?.canAskAgain,
      },
      changed: false, logs, matched: 0, unmatched: [], freedCopies: 0,
      removedCopies: pruned.removed, freedBytes: pruned.freed, mediaScanErrors: pruned.errors,
      removedCovers: 0, freedCoverBytes: 0,
      copiesLeft: pruned.kept, copiesLeftBytes: pruned.keptBytes, failedToDelete: pruned.failedToDelete,
    };
  }

  // 用户手动触发：强制重扫，保证看到的是最新相册
  let index;
  try {
    index = await getGalleryIndex(true);
  } catch (e) {
    throw new Error(`扫描相册目录失败：${e?.message || e}`);
  }

  const total = (logs || []).length;
  let changed = false;
  let matched = 0;
  const replacedUris = [];
  const unmatchedLogs = new Set();
  const next = [];

  for (let i = 0; i < total; i++) {
    const log = logs[i];
    if (!Array.isArray(log.localImages) || log.localImages.length === 0) {
      next.push(log);
      onProgress?.(i + 1, total);
      continue;
    }
    const result = await relinkEntries(log.localImages, index, THOROUGH_STAT_CHECKS);
    matched += result.matched;
    replacedUris.push(...result.replacedUris);
    if (result.brokenCount > 0) unmatchedLogs.add({ id: log.id, title: log.title });
    if (result.matched > 0) {
      changed = true;
      next.push({ ...log, localImages: result.entries });
    } else {
      next.push(log);
    }
    onProgress?.(i + 1, total);
  }

  // 被引用替换掉的本地副本删掉（选图器缓存 / 旧迁移副本，已由相册原片接管）。
  // 删之前再看一眼重链后的记录：同一个文件还被别的条目挂着就不能删。
  // 删除必须走 deletePathAsync（原生 File API）——expo-file-system 的 deleteAsync
  // 对 Android/data 里的文件一定会报 "isn't deletable"（详见 storagePaths 里的说明）
  let freedCopies = 0;
  const stillReferenced = referencedMediaNames(changed ? next : logs);
  for (const uri of replacedUris) {
    if (stillReferenced.has(mediaNameOfUri(uri))) continue;
    const res = await deletePathAsync(uri);
    if (res.ok) freedCopies++;
  }

  // 收尾再扫一遍副本目录：这一轮重链刚腾出来的、以及任何"记录里已经没有、
  // media/ 里还在"的影像都在这里删掉。放在重链之后，是因为只有重链后的记录
  // 才不再指向那些副本——开头那一遍看不到这一步的结果
  const pruned2 = await pruneOrphanMediaCopies(changed ? next : logs)
    .catch(() => ({ removed: 0, freed: 0, errors: [], kept: {}, keptBytes: {}, failedToDelete: null }));

  // 封面小图同理：换封面 / 删记录留下的孤儿封面也是"没有记录的图片"，一并清掉
  const covers = await pruneOrphanCovers(changed ? next : logs).catch(() => ({ removed: 0, freed: 0 }));

  return {
    permissionDenied: false,
    changed,
    logs: changed ? next : logs,
    matched,
    unmatched: [...unmatchedLogs],
    freedCopies,
    removedCopies: pruned.removed + pruned2.removed,
    freedBytes: pruned.freed + pruned2.freed,
    mediaScanErrors: [...pruned.errors, ...pruned2.errors],
    // 还剩哪些副本、为什么留着（界面据此如实报出来，不再只说一句"没有多余的"）
    copiesLeft: pruned2.kept || {},
    copiesLeftBytes: pruned2.keptBytes || {},
    failedToDelete: pruned2.failedToDelete || null,
    removedCovers: covers.removed,
    freedCoverBytes: covers.freed,
    failedCovers: covers.failed || 0,
  };
};
