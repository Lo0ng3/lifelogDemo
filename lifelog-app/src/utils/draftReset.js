// 「添加」页草稿的跨页控制。
//
// 为什么需要它：草稿里挂着的影像算"被引用"（见 media.setDraftMediaEntries），同步清孤儿
// 副本时不会动它们 —— 这是对的，但「添加」是常驻 tab、不会被卸载，用户分享进来又放弃之后
// 那批副本就永远留着（「数据目录」里会显示"添加页草稿 N 个"）。
// 这里给一条显式通道：别处（侧边栏「数据目录」）请求清空草稿 → 添加页清掉表单里的影像 →
// 那批副本随即变成没人引用的孤儿，同步 / 清理时就能删掉了。
const listeners = new Set();

export const onAddDraftReset = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const requestAddDraftReset = () => {
  let hit = 0;
  listeners.forEach((fn) => {
    try {
      fn();
      hit++;
    } catch {}
  });
  return hit;   // 返回"有没有添加页在监听"：为 0 说明那一页还没挂载过
};
