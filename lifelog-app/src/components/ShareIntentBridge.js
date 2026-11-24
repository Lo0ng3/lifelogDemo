// 系统分享 → App 选图：在图库/相册里选好照片，分享到「印记」，
// 这里把分享进来的影像收下来，再跳到「分享到印记」：
// 可以新建一条记录（影像挂到添加表单上），也可以追加到某条已有记录（见 ShareTargetScreen）。
//
// 为什么还要复制一份：expo-share-intent 是把分享内容落到**系统缓存目录**的，
// 缓存随时可能被系统清掉，而且那个路径不在 App 自己的媒体目录里——
// 保存记录时的"重链回相册原片"逻辑（isAppOwnedMediaPath / relinkNewEntries）
// 认不出它。所以统一复制进 MEDIA_DIR（默认内部 documentDirectory/media/，
// 原生模块 Paths 可用时是 Android/data/<包名>/files/media/）：
//   · 与"应用内选图"完全同一条流水线：保存（或追加到已有记录）时按 文件名/大小/尺寸
//     重链回相册原片，重链成功就把副本删掉，App 长期不持有副本；
//   · 重链不上（比如原片已删）也能当本地副本正常显示；
//   · 用户在「分享到印记」里取消时，这批副本由 ShareTargetScreen 删掉。
import { useEffect, useRef } from 'react';
import { useShareIntentContext } from 'expo-share-intent';
import * as FileSystem from 'expo-file-system/legacy';

import { navigationRef } from '../navigation/AppNavigator';
import { MEDIA_DIR, copyFileAsync, deletePathAsync, ensureDirAsync, getFileSizeAsync } from '../utils/storagePaths';

// 文件名里的非法字符换成下划线，其余（含中文）保留，方便和相册原片按名字匹配
const safeName = (name, index, video) => {
  const fallback = `shared_${Date.now()}_${index}.${video ? 'mp4' : 'jpg'}`;
  const raw = String(name || '').trim() || fallback;
  return raw.replace(/[\\/:*?"<>|\s]+/g, '_');
};

async function importSharedFiles(files) {
  await ensureDirAsync(MEDIA_DIR);

  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const rawFrom = f?.path;
    if (!rawFrom) continue;
    // iOS 偶尔给出不带 file:// 的绝对路径，统一补齐协议头
    const from = rawFrom.startsWith('/') ? `file://${rawFrom}` : rawFrom;
    const video = String(f.mimeType || '').startsWith('video/');
    const name = safeName(f.fileName, i, video);
    let to = `${MEDIA_DIR}/${name}`;
    try {
      // 目标不存在时 expo-file-system 的 getInfoAsync 会直接抛（沙盒外的路径它按
      // File.canRead() 判权限，不存在的文件判为不可读），所以这里必须自己吞掉
      const exist = await FileSystem.getInfoAsync(to).catch(() => ({ exists: false }));
      if (exist.exists) to = `${MEDIA_DIR}/${Date.now()}_${i}_${name}`;
      await copyFileAsync(from, to);
      // 复制完就把系统缓存 / iOS App Group 容器里那份删掉（走原生 deletePathAsync 绕开沙盒限制）
      await deletePathAsync(from).catch(() => {});
    } catch (e) {
      console.warn('[share] 复制分享的影像失败', from, e?.message || e);
      continue;
    }
    const w = typeof f.width === 'number' && f.width > 0 ? f.width : null;
    const h = typeof f.height === 'number' && f.height > 0 ? f.height : null;
    const size = typeof f.size === 'number' && f.size > 0
      ? f.size
      : await getFileSizeAsync(to);
    entries.push({
      uri: to,
      isVideo: video,
      // filename 记"相册原名"（不是落盘时可能加了时间戳的那个），
      // 这样：① 重链回相册时按名字匹配更容易命中；② 同一张图重复分享能被识别成重复
      filename: String(f.fileName || '').trim() || name,
      size: typeof size === 'number' ? size : undefined,
      ...(w ? { w } : {}),
      ...(h ? { h } : {}),
      ...(w && h ? { ratio: w / h } : {}),
    });
  }
  return entries;
}

// 等导航容器就绪再跳（冷启动分享时导航还没挂好）
const navigateWhenReady = (name, params, tries = 0) => {
  if (navigationRef.isReady()) {
    navigationRef.navigate(name, params);
    return;
  }
  if (tries > 40) return;                       // 约 5 秒还没就绪就放弃，避免死循环
  setTimeout(() => navigateWhenReady(name, params, tries + 1), 120);
};

export default function ShareIntentBridge() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const handling = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || handling.current) return;
    const files = (shareIntent?.files || []).filter((f) => f?.path);
    handling.current = true;
    (async () => {
      try {
        const entries = files.length ? await importSharedFiles(files) : [];
        resetShareIntent();
        if (entries.length) {
          // shareToken 用时间戳：同一批影像再分享一次也能触发接收端
          navigateWhenReady('ShareTarget', { sharedMedia: entries, shareToken: Date.now() });
        }
      } catch (e) {
        console.warn('[share] 处理分享内容失败', e?.message || e);
      } finally {
        handling.current = false;
      }
    })();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  return null;
}
