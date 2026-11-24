import { Platform, requireNativeModule } from 'expo-modules-core';

// 双端系统微缩略图管道：
// - Android：MediaStore loadThumbnail（系统相册同款）
// - iOS：Photos 框架 requestImage（系统相册同款，照片/视频出帧，支持 iCloud 拉取）
// assetId 在两端类型不同（Android 数字 / iOS 字符串），这里统一适配
const native = requireNativeModule('Thumbs');

export default {
  getThumbnailAsync(assetId, isVideo, size) {
    const id = Platform.OS === 'ios' ? String(assetId) : Number(assetId);
    return native.getThumbnailAsync(id, isVideo, size);
  },
  getAssetFileSizeAsync(assetId) {
    if (Platform.OS !== 'ios' || typeof native?.getAssetFileSizeAsync !== 'function') {
      return Promise.resolve(null);
    }
    return native.getAssetFileSizeAsync(String(assetId));
  },
  getLivePhotoStatusAsync(assetId) {
    if (Platform.OS !== 'ios' || typeof native?.getLivePhotoStatusAsync !== 'function') {
      return Promise.resolve(false);
    }
    return native.getLivePhotoStatusAsync(String(assetId));
  },
  getLivePhotoVideoUriAsync(assetId) {
    if (Platform.OS !== 'ios' || typeof native?.getLivePhotoVideoUriAsync !== 'function') {
      return Promise.resolve(null);
    }
    return native.getLivePhotoVideoUriAsync(String(assetId));
  },
  getPlayableVideoUriAsync(assetId) {
    if (Platform.OS !== 'ios' || typeof native?.getPlayableVideoUriAsync !== 'function') {
      return Promise.resolve(null);
    }
    return native.getPlayableVideoUriAsync(String(assetId));
  },
  presentPhotoPickerAsync(selectionLimit = 0) {
    if (Platform.OS !== 'ios' || typeof native?.presentPhotoPickerAsync !== 'function') {
      return Promise.resolve(null);
    }
    return native.presentPhotoPickerAsync(Number(selectionLimit) || 0);
  },
};
