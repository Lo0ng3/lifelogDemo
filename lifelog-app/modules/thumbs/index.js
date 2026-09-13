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
};
