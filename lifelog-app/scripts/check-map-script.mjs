// 地图脚本回归自检（不需要真机/网络）：
// 用桩 Leaflet + 桩 DOM 把 mapHtml 生成的那段脚本跑一遍，验证
//   ① 脏坐标（缺失 / NaN / 字符串异常）不会让整段脚本抛错；
//   ② 缩放、轨迹/标点开关的 onclick 一定绑上了；
//   ③ 合法标点照常创建。
//
// 背景：1.6.6 的「地图能显示、标点不显示、放大缩小点了没反应」就是 ① 的反面——
// Leaflet 的 LatLng 遇到 undefined 会抛 "Invalid LatLng object"，
// 后面的绘制和控件绑定全被打断。
//
// 用法：node scripts/check-map-script.mjs
import { mkdtempSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const scratch = mkdtempSync(join(tmpdir(), 'rc-mapcheck-'));
const asModule = async (rel) => {
  const target = join(scratch, basename(rel).replace(/\.js$/, '.mjs'));
  copyFileSync(join(root, rel), target);
  return import(pathToFileURL(target).href);
};
const { buildMapHtml } = await asModule('src/utils/mapHtml.js');

const points = [
  // 正常地点
  { id: 1, kind: 'location', title: '外滩', date: '2023-10-02', note: '', lat: 31.2304, lng: 121.4737 },
  // 脏数据：longitude 缺失（JSON 序列化后键会直接消失）——旧版本就是死在这一条上
  { id: 2, kind: 'location', title: '坐标缺失的记录', date: '2023-10-03', note: '', lat: 31.2, lng: undefined },
  // 脏数据：字符串乱码
  { id: 3, kind: 'ticket', subType: 'flight', title: '异常坐标', date: '2023-10-04', note: '', lat: 'N/A', lng: 'N/A' },
  // 正常旅票
  { id: 4, kind: 'ticket', subType: 'train', title: '北京南', date: '2023-10-07', note: '', lat: '39.8652', lng: '116.3785' },
];
const segs = [
  { from: { name: 'A', longitude: 116.4, latitude: 39.9 }, to: { name: 'B', longitude: 121.32, latitude: 31.19 }, count: 2, subType: 'train' },
  // 脏数据：终点坐标缺失
  { from: { name: 'A', longitude: 116.4, latitude: 39.9 }, to: { name: 'C' }, count: 1, subType: 'flight' },
];

const html = buildMapHtml({ points, segs, tdtKey: 'FAKE_KEY', colors: null, leafletJs: '/* stub */', leafletCss: '' });
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const appScript = scripts[scripts.length - 1];

/* ----------------------------- 桩 DOM / Leaflet ----------------------------- */
const makeEl = (id) => ({
  id, textContent: '', innerHTML: '', className: '', onclick: null,
  style: {}, addEventListener() {}, getAttribute() { return null; },
  offsetWidth: 224, offsetHeight: 90,
});
const dom = new Map();
const $ = (id) => {
  if (!dom.has(id)) dom.set(id, makeEl(id));
  return dom.get(id);
};
const calls = { zoomIn: 0, zoomOut: 0, fitBounds: 0, markers: [], polylines: [], flyTo: 0, flyToZoom: null, popupOpen: 0, mapOptions: null };

// 和 Leaflet 一样严格：NaN / undefined 一律抛错
const latLng = (ll) => {
  if (!Array.isArray(ll) || isNaN(ll[0]) || isNaN(ll[1])) {
    throw new Error('Invalid LatLng object: (' + ll + ')');
  }
  return ll;
};
const mapObj = {
  attributionControl: { setPrefix() {} },
  on() {}, setView() { return this; }, getZoom() { return 5; }, getCenter() { return { lat: 0, lng: 0 }; },
  latLngToContainerPoint() { return { x: 180, y: 300 }; }, getSize() { return { x: 360, y: 600 }; },
  flyTo(_latlng, zoom) { calls.flyTo++; calls.flyToZoom = zoom; }, invalidateSize() {},
  fitBounds() { calls.fitBounds++; },
  zoomIn() { calls.zoomIn++; }, zoomOut() { calls.zoomOut++; },
  closePopup() { calls.popupOpen = Math.max(0, calls.popupOpen - 1); },
};
const layer = () => ({ addTo() { return this; }, clearLayers() {} });
const L = {
  map: (_id, options) => { calls.mapOptions = options; return mapObj; },
  tileLayer: () => layer(),
  layerGroup: () => layer(),
  divIcon: (o) => o,
  marker: (ll, opts) => {
    // 轨迹上的「×N」次数徽章是 interactive:false，标点才是可点的
    const state = { open: false, options: opts || {} };
    // 标点的 DOM 元素桩：记录注册的处理器，方便测试"直接绑 DOM"的手势路径
    const el = {
      __rcTapBound: false,
      __handlers: {},
      addEventListener(type, fn) { (el.__handlers[type] = el.__handlers[type] || []).push(fn); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    };
    const api = {
      addTo() { return this; },
      bindPopup() { return this; },
      on(evt, fn) { if (evt === 'click') api.__click = fn; return this; },
      openPopup() { state.open = true; calls.popupOpen++; return this; },
      closePopup() { state.open = false; calls.popupOpen = Math.max(0, calls.popupOpen - 1); return this; },
      isPopupOpen() { return state.open; },
      getElement() { return el; },
      __state: state,
      __el: el,
    };
    calls.markers.push({ ll: latLng(ll), isBadge: opts && opts.interactive === false, api });
    return api;
  },
  polyline: (path) => {
    path.forEach(latLng);
    calls.polylines.push(path);
    return { addTo() { return this; } };
  },
};

const documentStub = { getElementById: $, addEventListener() {}, body: { className: '' } };
const windowStub = { ReactNativeWebView: { postMessage() {} }, L };

let thrown = null;
try {
  new Function('document', 'window', 'L', 'setTimeout', 'clearTimeout', 'isFinite', appScript)(
    documentStub, windowStub, L, (fn) => { if (typeof fn === 'function') fn(); }, () => {}, isFinite
  );
} catch (e) {
  thrown = e;
}

/* -------------------------------- 断言 -------------------------------- */
const fail = [];
if (thrown) fail.push(`脚本抛错：${thrown.message}`);
if (!dom.has('zin') || typeof $('zin').onclick !== 'function') fail.push('放大按钮没绑上 onclick');
if (!dom.has('zout') || typeof $('zout').onclick !== 'function') fail.push('缩小按钮没绑上 onclick');
if (!dom.has('tTraj') || typeof $('tTraj').onclick !== 'function') fail.push('轨迹开关没绑上 onclick');
if (!dom.has('tLoc') || typeof $('tLoc').onclick !== 'function') fail.push('标点开关没绑上 onclick');
const pins = calls.markers.filter((m) => !m.isBadge);
const badges = calls.markers.filter((m) => m.isBadge);
if (pins.length !== 2) fail.push(`标点数量应为 2（合法的两条记录），实际 ${pins.length}`);
if (badges.length !== 1) fail.push(`次数徽章应为 1（往返 2 次那条轨迹），实际 ${badges.length}`);
if (calls.polylines.length !== 1) fail.push(`轨迹数量应为 1（合法的一段），实际 ${calls.polylines.length}`);

$('zin').onclick?.();
$('zout').onclick?.();
if (calls.zoomIn !== 1 || calls.zoomOut !== 1) fail.push('点击缩放按钮没有触发地图缩放');

/* -------------------- 标点手势：单击看评论 / 双击放大飞过去 -------------------- */
if (!calls.mapOptions || calls.mapOptions.closePopupOnClick !== false) {
  fail.push('地图没有关闭 closePopupOnClick（会导致单击标点弹出的评论被立刻关掉）');
}
if (pins.some((p) => p.api.__state.options.bubblingMouseEvents !== false)) {
  fail.push('标点没有关闭 bubblingMouseEvents（点击会冒泡给地图，评论同样会被关掉）');
}

const pin = pins[0].api;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 直接走"绑在标点 DOM 上"的那条路（真机上的主路径）：pointerdown + pointerup
const domTap = (x = 5, y = 5) => {
  const h = pin.__el.__handlers;
  h.pointerdown?.forEach((fn) => fn({ clientX: x, clientY: y, stopPropagation() {}, preventDefault() {}, cancelable: true }));
  h.pointerup?.forEach((fn) => fn({ clientX: x, clientY: y, stopPropagation() {}, preventDefault() {}, cancelable: true }));
};
if (!pin.__el.__handlers.pointerdown || !pin.__el.__handlers.pointerup) {
  fail.push('标点没有绑定 DOM 手势（pointerdown/pointerup）');
}
// 等过双击判定窗口再点，确保这一下被当成"单击"
const singleTap = async () => { await wait(360); domTap(); };
// ① 单击一次 → 应该立刻弹出评论，并且不移动地图
const flyBefore = calls.flyTo;
await singleTap();
if ($('rcCard').style.display !== 'block') fail.push('单击标点没有显示评论卡');
if (calls.flyTo !== flyBefore) fail.push('单击标点不该移动地图');
// ② 隔开一段时间再点一次 → 只是收起评论
await singleTap();
if ($('rcCard').style.display !== 'none') fail.push('再次单击没能收起评论卡');
// ③ 快速连点两次 → 放大飞到该标点，并弹出评论
const flyBefore2 = calls.flyTo;
await singleTap();       // 第一下：弹出评论
await wait(80);          // 真实双击的间隔
domTap();                // 第二下：判定为双击
if (calls.flyTo !== flyBefore2 + 1) fail.push('快速连点两次没有飞到该标点');
if ($('rcCard').style.display !== 'block') fail.push('双击后没有显示评论卡');
// ④ 放大级别：双击后的目标缩放不该超过 12（之前直接跳到 13，观感太冲）
if (calls.flyToZoom > 12) fail.push(`双击放大过度：目标缩放 ${calls.flyToZoom}`);

const droppedShown = /坐标不完整/.test($('banner').textContent);

console.log(`标点创建 ${pins.length} 个，次数徽章 ${badges.length} 个，轨迹 ${calls.polylines.length} 段，缩放调用 ${calls.zoomIn}/${calls.zoomOut}`);
console.log(`手势自检：单击开评论 / 再点收起 / 连点两次 flyTo（共 ${calls.flyTo} 次飞点）`);
console.log(`脏坐标提示：${droppedShown ? $('banner').textContent : '（未显示）'}`);
if (fail.length) {
  console.error('✗ 自检未通过：\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log('✓ 通过：脏坐标被跳过，标点/轨迹正常绘制，缩放与开关全部可用');
