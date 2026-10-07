// 最近一次"实况动效提取"失败的原因，给「数据目录」显示用。
//
// 为什么单独放一个模块：livePhoto 和 storagePaths 都要用它（提取失败时写、看目录时读），
// 但让 storagePaths 去 import livePhoto 会把 AsyncStorage / expo-media-library 一起拖进来。
// 只存一句短原因，成功时清掉。
let lastLivePhotoError = null;

export const setLivePhotoError = (msg) => {
  lastLivePhotoError = msg ? String(msg).slice(0, 160) : null;
};

export const getLivePhotoError = () => lastLivePhotoError;
