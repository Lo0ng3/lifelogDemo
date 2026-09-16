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
});
const dom = new Map();
const $ = (id) => {
  if (!dom.has(id)) dom.set(id, makeEl(id));
  return dom.get(id);
};
const calls = { zoomIn: 0, zoomOut: 0, fitBounds: 0, markers: [], polylines: [] };

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
  flyTo() {}, invalidateSize() {},
  fitBounds() { calls.fitBounds++; },
  zoomIn() { calls.zoomIn++; }, zoomOut() { calls.zoomOut++; },
};
const layer = () => ({ addTo() { return this; }, clearLayers() {} });
const L = {
  map: () => mapObj,
  tileLayer: () => layer(),
  layerGroup: () => layer(),
  divIcon: (o) => o,
  marker: (ll, opts) => {
    // 轨迹上的「×N」次数徽章是 interactive:false，标点才是可点的
    calls.markers.push({ ll: latLng(ll), isBadge: opts && opts.interactive === false });
    return { addTo() { return this; }, bindPopup() { return this; }, on() { return this; }, openPopup() {} };
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

const droppedShown = /坐标不完整/.test($('banner').textContent);

console.log(`标点创建 ${pins.length} 个，次数徽章 ${badges.length} 个，轨迹 ${calls.polylines.length} 段，缩放调用 ${calls.zoomIn}/${calls.zoomOut}`);
console.log(`脏坐标提示：${droppedShown ? $('banner').textContent : '（未显示）'}`);
if (fail.length) {
  console.error('✗ 自检未通过：\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log('✓ 通过：脏坐标被跳过，标点/轨迹正常绘制，缩放与开关全部可用');
