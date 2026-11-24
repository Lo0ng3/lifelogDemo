import { Platform } from 'react-native';
import { getLivePhotoInfo } from './livePhoto';
import {
  getVideoPoster,
  isVideoEntry,
  normalizeMediaEntry,
  resolveMediaUri,
} from './media';

// 给单条影像补齐可持久化的元数据：
// - 视频：360px 压缩封面（base64）
// - 照片：实况状态 live / not-live / unknown
export const detectMediaMetadata = async (rawEntry) => {
  const entry = normalizeMediaEntry(rawEntry);
  if (!entry) return rawEntry;

  if (isVideoEntry(entry)) {
    const poster = await getVideoPoster(entry).catch(() => null);
    return {
      ...entry,
      liveStatus: 'not-applicable',
      metadataCheckedAt: Date.now(),
      ...(poster ? { videoPoster: poster } : {}),
    };
  }

  try {
    // iOS 上直接查相册元数据即可判定实况（不触发 iCloud 下载配对视频，播时再拉）
    const info = Platform.OS === 'ios' && entry.assetId
      ? await getLivePhotoInfo(entry, { full: false })
      : await getLivePhotoInfo({ ...entry, uri: await resolveMediaUri(entry) }, { full: true });
    return {
      ...entry,
      liveStatus: info?.live ? 'live' : 'not-live',
      liveSource: info?.source || null,
      liveCheckedAt: Date.now(),
      metadataCheckedAt: Date.now(),
    };
  } catch {
    return {
      ...entry,
      liveStatus: 'unknown',
      liveCheckedAt: Date.now(),
      metadataCheckedAt: Date.now(),
    };
  }
};
