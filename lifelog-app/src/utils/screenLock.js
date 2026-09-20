// 屏幕方向锁：全 App 只有「地图全屏」允许横屏，其它页面（列表 / 日历 / 添加 / 详情）一律竖屏。
//
// 用 try + require 取原生模块：万一装的是没有这个依赖的旧包（没重新构建 APK），
// 这里降级成"不锁方向"，而不是让整个页面崩掉。

let ScreenOrientation = null;
try {
  ScreenOrientation = require('expo-screen-orientation');
} catch {
  ScreenOrientation = null;
}

const lock = async (which) => {
  try {
    const want = ScreenOrientation?.OrientationLock?.[which];
    if (!ScreenOrientation || want == null) return;
    await ScreenOrientation.lockAsync(want);
  } catch {
    // 模拟器 / 旧安装包上锁不了就忽略
  }
};

export const lockLandscape = () => lock('LANDSCAPE');
export const lockPortrait = () => lock('PORTRAIT_UP');

// 等屏幕真的转回竖屏：监听方向变化 + 立刻查一次 + 800ms 兜底。
// 横屏里直接跳二级页会出现布局错位，跳转前等这一步就稳了。
export const waitPortrait = () => new Promise((resolve) => {
  let done = false;
  let sub = null;
  const finish = () => {
    if (done) return;
    done = true;
    try { if (sub?.remove) sub.remove(); } catch {}
    resolve();
  };
  const SO = ScreenOrientation;
  if (!SO || !SO.addOrientationChangeListener) { setTimeout(finish, 420); return; }
  try {
    sub = SO.addOrientationChangeListener((e) => {
      if (e?.orientationInfo?.orientation === SO.Orientation?.PORTRAIT_UP) finish();
    });
  } catch {}
  try {
    SO.getOrientationAsync?.()
      .then((o) => { if (o === SO.Orientation?.PORTRAIT_UP) finish(); })
      .catch(() => {});
  } catch {}
  setTimeout(finish, 800);
});

// 需要自己监听方向变化时（比如详情页）用它，没模块时返回 null
export const screenOrientationModule = () => ScreenOrientation;
