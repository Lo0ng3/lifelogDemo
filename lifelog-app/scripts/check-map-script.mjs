// 地图脚本回归自检（不需要真机/网络）：
// 把 mapHtml 生成的那段脚本分别用「桩 Leaflet」和「桩 AMap」跑一遍，验证
//   ① 脏坐标（缺失 / NaN / 字符串异常）不会让整段脚本抛错；
//   ② 缩放、轨迹/标点开关、全屏按钮的 onclick 一定绑上了；
//   ③ 合法标点照常创建；
//   ④ 同一坐标的多条记录合成一个标点、同名但坐标有差异的地点也并成一根针
//      （落点取记录最多的那一簇），卡片能左右翻记录；
//   ⑤ 全屏按钮把「进/退全屏」发给 RN，RN 回调后按钮图标会换；
//   ⑥ 栅格模式：缩放动画期间不重算瓦片网格，高德底图（不需要 key）也会预热下一级瓦片；
//   ⑦ 矢量模式（高德 JS API 2.0）：按 key/安全密钥正确初始化、深色走官方深色样式、
//      标点与轨迹用 AMap 的坐标顺序画出来、出图失败会给 RN 发 jsApiFailed 以便回退；
//   ⑧ 出行方式筛选（飞机/火车/汽车/轮船，多选）按类型过滤轨迹，开关状态跨「轨迹」开关保留；
//      跑道型胶囊的命中区按形状判——点圆角外侧那块不算点到按钮。
//
// 背景：1.6.6 的「地图能显示、标点不显示、放大缩小点了没反应」就是 ① 的反面——
// 引擎的 LatLng 遇到 undefined 会抛错，后面的绘制和控件绑定全被打断。
//
// 用法：node scripts/check-map-script.mjs
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
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
// 带相对依赖的源码（mapPlaces → format）：复制时补上 .mjs 后缀，node 才解析得了
const asModuleWithDeps = async (rel, deps = []) => {
  const copy = (r) => {
    const code = readFileSync(join(root, r), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.mjs'");
    const target = join(scratch, basename(r).replace(/\.js$/, '.mjs'));
    writeFileSync(target, code);
    return target;
  };
  deps.forEach(copy);
  return import(pathToFileURL(copy(rel)).href);
};
const { buildPlaceAnchors, anchorOf, placeKeyOf, latLngOfPoint } = await asModuleWithDeps('src/utils/mapPlaces.js', ['src/utils/format.js']);

const points = [
  // 正常地点
  { id: 1, kind: 'location', title: '外滩', date: '2023-10-02', note: '', lat: 31.2304, lng: 121.4737 },
  // 同一个地点又来了一次（4 位小数相同，≈11 米内）：应当并进上面那个标点，而不是再插一根针
  { id: 11, kind: 'location', title: '外滩 · 夜景', date: '2023-10-05', note: '又去了一次', lat: 31.23041, lng: 121.47372 },
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

const fail = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================== 地图数据侧的同名落点（HomeScreen 直接用的纯函数） ================== */
// 同名归一是"一个地方一根针"的源头：地点印记和旅票出发地/目的地一起算，取记录最多的坐标簇；
// 老数据里的「未命名记录」占位不算名字（否则没名字的印记会全并到一根针上）。
const anchorLogs = [
  // 同一个机场：两条地点印记 + 一条航班出发地 → 3 次都落在 40.0723 那一簇
  { id: 1, baseType: 'location', title: '北京首都国际机场', coordinates: { latitude: 40.0723, longitude: 116.5971 } },
  { id: 2, baseType: 'location', title: '北京首都', coordinates: { latitude: 40.07231, longitude: 116.59711 } },
  { id: 3, baseType: 'ticket', subType: 'flight', title: '北京首都 → 上海虹桥',
    start: { name: '北京首都国际机场', latitude: 40.07232, longitude: 116.59712 },
    end: { name: '上海虹桥国际机场', latitude: 31.1972, longitude: 121.3363 } },
  // 同名但坐标差出一大截、记录又少的那一簇：不该抢走落点
  { id: 4, baseType: 'ticket', subType: 'flight', title: '北京首都 → 上海虹桥',
    start: { name: '北京首都', latitude: 40.30, longitude: 116.80 },
    end: { name: '上海虹桥站', latitude: 31.1946, longitude: 121.3205 } },
  // 没名字的占位（老数据）不参与合并；脏坐标也不参与
  { id: 5, baseType: 'location', title: '未命名记录', coordinates: { latitude: 1, longitude: 1 } },
  { id: 6, baseType: 'location', title: '未命名记录', coordinates: { latitude: 30, longitude: 100 } },
  { id: 7, baseType: 'ticket', subType: 'train', title: 'A → B', start: { name: '坏坐标', latitude: 'N/A', longitude: 'N/A' } },
];
let anchorSummary = '';
{
  const anchors = buildPlaceAnchors(anchorLogs);
  const keyBj = placeKeyOf('北京首都国际机场');
  if (!keyBj) fail.push('地名归一把「北京首都国际机场」判成了没有名字');
  if (keyBj !== placeKeyOf(' 北京首都 ')) fail.push('「北京首都国际机场」和「北京首都」应当归成同一个地方');
  if (placeKeyOf('上海虹桥站') === placeKeyOf('上海虹桥国际机场')) {
    fail.push('「上海虹桥站」和「上海虹桥国际机场」不该被当成同一个地方');
  }
  const bj = anchors.get(keyBj);
  if (!bj) fail.push('同名落点表里没有「北京首都」');
  else if (Math.abs(bj.lat - 40.0723) > 1e-6 || Math.abs(bj.lng - 116.5971) > 1e-6) {
    fail.push(`「北京首都」的落点应取记录最多的那一簇（40.0723,116.5971），实际 ${JSON.stringify(bj)}`);
  }
  if (!anchors.get(placeKeyOf('上海虹桥国际机场'))) fail.push('旅票的到达地没有参与同名落点计算');
  if (placeKeyOf('未命名记录') !== '') fail.push('「未命名记录」这种占位不该被当成地名参与合并');
  if ([...anchors.keys()].some((k) => !k)) fail.push('落点表里不该出现空名字');
  if (anchors.has(placeKeyOf('坏坐标'))) fail.push('脏坐标的记录不该进落点表');
  const fallback = anchorOf(anchors, '从没记过的地方', { lat: 5, lng: 6 });
  if (fallback.lat !== 5 || fallback.lng !== 6) fail.push('没记录过的名字应当退回它自己的坐标');
  anchorSummary = `${keyBj} → ${JSON.stringify(anchors.get(keyBj))}（落点表 ${anchors.size} 项）`;
}

/* ===== 端到端：地点印记 + 旅票起终点同名时，图上一根针、弧线正好连到针上 ===== */
// 复刻 HomeScreen 里那几步（地点用 coordinates、旅票用 start/end，坐标都先过同名落点）
const buildMapDataLikeHome = (logs) => {
  const anchors = buildPlaceAnchors(logs);
  const points = [];
  const segMap = new Map();
  const sorted = [...logs].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const item of sorted) {
    const note = item.comment || item.subtitle || '';
    const loc = latLngOfPoint(item.coordinates);
    if (loc) {
      const at = anchorOf(anchors, item.title, loc);
      points.push({ id: item.id, kind: 'location', title: item.title, date: item.date, note, lat: at.lat, lng: at.lng });
    }
    for (const p of [item.start, item.end]) {
      const at = anchorOf(anchors, p?.name, latLngOfPoint(p));
      if (at) points.push({ id: item.id, kind: 'ticket', subType: item.subType, title: String(p.name).replace(/(国际机场|机场)$/, ''), date: item.date, note, lat: at.lat, lng: at.lng });
    }
    if (item.baseType === 'ticket' && latLngOfPoint(item.start) && latLngOfPoint(item.end)) {
      const fromAt = anchorOf(anchors, item.start?.name, latLngOfPoint(item.start));
      const toAt = anchorOf(anchors, item.end?.name, latLngOfPoint(item.end));
      const key = `${fromAt.lat.toFixed(4)},${fromAt.lng.toFixed(4)}→${toAt.lat.toFixed(4)},${toAt.lng.toFixed(4)}`;
      const hit = segMap.get(key);
      if (hit) hit.count++;
      else segMap.set(key, {
        from: { name: item.start.name, latitude: fromAt.lat, longitude: fromAt.lng },
        to: { name: item.end.name, latitude: toAt.lat, longitude: toAt.lng },
        count: 1, subType: item.subType,
      });
    }
  }
  return { points, segs: [...segMap.values()] };
};
{
  // 同一个机场：一条地点印记（40.0723）+ 两条航班出发地（40.0750 / 40.0750…），
  // 出发地的记录更多 → 落点取出发地那一簇；两条航班是同一段行程 → 只画一条弧线
  const homeLikeLogs = [
    { id: 1, baseType: 'location', title: '北京首都国际机场', date: '2023-01-01', coordinates: { latitude: 40.0723, longitude: 116.5971 } },
    { id: 2, baseType: 'ticket', subType: 'flight', title: '北京首都 → 上海虹桥', date: '2023-02-01',
      start: { name: '北京首都', latitude: 40.0750, longitude: 116.6000 },
      end: { name: '上海虹桥国际机场', latitude: 31.1972, longitude: 121.3363 } },
    { id: 3, baseType: 'ticket', subType: 'flight', title: '北京首都 → 上海虹桥', date: '2023-03-01',
      start: { name: '北京首都', latitude: 40.07501, longitude: 116.60001 },
      end: { name: '上海虹桥国际机场', latitude: 31.1972, longitude: 121.3363 } },
  ];
  const data = buildMapDataLikeHome(homeLikeLogs);
  const live = bootMap({ points: data.points, segs: data.segs, tdtKey: 'FAKE_KEY' });
  if (live.thrown) fail.push(`同名落点这一遍脚本抛错：${live.thrown.message}`);
  const livePins = live.calls.markers.filter((m) => !m.isBadge);
  if (livePins.length !== 2) {
    fail.push(`地点印记 + 旅票起终点同名时应并成 2 根针（北京首都 / 上海虹桥），实际 ${livePins.length}`);
  }
  if (live.calls.polylines.length !== 1) {
    fail.push(`同一段行程的两条记录应聚成 1 条弧线，实际 ${live.calls.polylines.length}`);
  }
  const bjPin = livePins.find((m) => Math.abs(m.ll[0] - 40.0750) < 1e-6);
  if (!bjPin) fail.push('「北京首都」的落点应当取记录更多的出发地那一簇（40.0750）');
  const seg = data.segs[0];
  if (!seg) fail.push('没有生成轨迹段');
  else {
    // 弧线两端必须正好压在两根针上，否则看起来就是"线没连到点"
    const onPin = (lat, lng) => livePins.some((m) => Math.abs(m.ll[0] - lat) < 1e-6 && Math.abs(m.ll[1] - lng) < 1e-6);
    if (!onPin(seg.from.latitude, seg.from.longitude) || !onPin(seg.to.latitude, seg.to.longitude)) {
      fail.push(`弧线两端没有压在针上：${JSON.stringify(seg.from)} → ${JSON.stringify(seg.to)}`);
    }
    if (seg.count !== 2) fail.push(`同一段行程的两条记录应当合并计数（count 应为 2），实际 ${seg.count}`);
  }
}

/* ============================ 桩环境 + 跑一遍脚本 ============================ */
// 每跑一遍都用全新的 DOM / 引擎桩，避免几次之间互相污染
function bootMap({
  points: pts, segs: sgs, tdtKey = '', provider = 'tianditu',
  jsApiKey = '', securityCode = '', dark = false, amapLoaded = true,
}) {
  const html = buildMapHtml({
    points: pts, segs: sgs, tdtKey, provider, jsApiKey, securityCode, dark,
    colors: null, leafletJs: '/* stub */', leafletCss: '',
  });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const appScript = scripts[scripts.length - 1];

  const makeEl = (id) => {
    const el = {
      id, textContent: '', innerHTML: '', className: '', onclick: null, tagName: 'div',
      style: {}, __handlers: {},
      addEventListener(type, fn) { (el.__handlers[type] = el.__handlers[type] || []).push(fn); },
      getAttribute() { return null; }, setAttribute() {},
      appendChild() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 28 }),
      offsetWidth: 224, offsetHeight: 90, clientWidth: 360, clientHeight: 600,
    };
    return el;
  };
  const dom = new Map();
  const $ = (id) => {
    if (!dom.has(id)) dom.set(id, makeEl(id));
    return dom.get(id);
  };
  const calls = {
    zoomIn: 0, zoomOut: 0, fitBounds: 0, fitView: 0, markers: [], polylines: [], flyTo: 0, flyToZoom: null,
    popupOpen: 0, mapOptions: null, tileOptions: [], messages: [], images: [], mapHandlers: {},
    amapMapOptions: null, amapZoomCenter: null, added: [],
  };

  /* ------------------------------ 桩 Leaflet ------------------------------ */
  // 和 Leaflet 一样严格：NaN / undefined 一律抛错
  const latLng = (ll) => {
    if (!Array.isArray(ll) || isNaN(ll[0]) || isNaN(ll[1])) {
      throw new Error('Invalid LatLng object: (' + ll + ')');
    }
    return ll;
  };
  const mapObj = {
    attributionControl: { setPrefix() {} },
    doubleClickZoom: { disable() { calls.doubleClickDisabled = true; } },
    on(evt, fn) {
      // 事件名可能是 'moveend zoomend' 这样的组合串，逐个记下来方便自检里手动触发
      String(evt).split(' ').forEach((name) => { (calls.mapHandlers[name] = calls.mapHandlers[name] || []).push(fn); });
    },
    setView() { return this; }, getZoom() { return 5; }, getCenter() { return { lat: 0, lng: 0 }; },
    latLngToContainerPoint() { return { x: 180, y: 300 }; }, getSize() { return { x: 360, y: 600 }; },
    flyTo(_latlng, zoom) { calls.flyTo++; calls.flyToZoom = zoom; }, invalidateSize() {},
    fitBounds() { calls.fitBounds++; }, whenReady(fn) { fn(); },
    zoomIn() { calls.zoomIn++; }, zoomOut() { calls.zoomOut++; },
    closePopup() { calls.popupOpen = Math.max(0, calls.popupOpen - 1); },
  };
  const layer = () => ({ addTo() { return this; }, addLayer() { return this; }, clearLayers() {} });
  const L = {
    map: (_id, options) => { calls.mapOptions = options; return mapObj; },
    tileLayer: (url, options) => { calls.tileOptions.push({ url, options }); return layer(); },
    layerGroup: () => layer(),
    divIcon: (o) => o,
    marker: (ll, opts) => {
      // 轨迹上的「×N」次数徽章是 interactive:false，标点才是可点的
      const state = { open: false, options: opts || {} };
      // 标点的 DOM 元素桩：记录注册的处理器，方便测试"直接绑 DOM"的手势路径
      const el = makeEl('pin');
      const api = {
        addTo() { return this; },
        bindPopup() { return this; },
        on(evt, fn) {
          if (evt === 'click') api.__click = fn;
          if (evt === 'add') fn();
          return this;
        },
        openPopup() { state.open = true; calls.popupOpen++; return this; },
        closePopup() { state.open = false; calls.popupOpen = Math.max(0, calls.popupOpen - 1); return this; },
        isPopupOpen() { return state.open; },
        getElement() { return el; },
        __state: state, __el: el,
      };
      calls.markers.push({ ll: latLng(ll), isBadge: opts && opts.interactive === false, api, el, opts });
      return api;
    },
    polyline: (path) => {
      path.forEach(latLng);
      calls.polylines.push({ path });
      return { addTo() { return this; } };
    },
  };

  /* ------------------------------ 桩 AMap ------------------------------ */
  const amapMap = {
    __handlers: {},
    on(evt, fn) { (amapMap.__handlers[evt] = amapMap.__handlers[evt] || []).push(fn); },
    add(o) { (Array.isArray(o) ? o : [o]).forEach((x) => calls.added.push(x)); },
    remove(o) { (Array.isArray(o) ? o : [o]).forEach((x) => { const i = calls.added.indexOf(x); if (i >= 0) calls.added.splice(i, 1); }); },
    setFitView(_ov, _imm, _avoid, maxZoom) { calls.fitView++; calls.fitViewMaxZoom = maxZoom; },
    setZoomAndCenter(zoom, center, immediately, duration) { calls.amapZoomCenter = { zoom, center, immediately, duration }; },
    zoomIn() { calls.zoomIn++; }, zoomOut() { calls.zoomOut++; },
    getZoom() { return 6; },
    getCenter() { return { lng: 121.4, lat: 31.2 }; },
    lngLatToContainer() { return { x: 180, y: 300, getX() { return 180; }, getY() { return 300; } }; },
    resize() { calls.amapResize = (calls.amapResize || 0) + 1; },
  };
  const AMapStub = {
    // 注意：真机上是 `new AMap.Map(...)`，所以桩必须是可构造的普通函数，不能是箭头函数
    Map: function (_id, opts) { calls.amapMapOptions = opts; return amapMap; },
    Marker: function (opts) {
      const api = { __handlers: {}, on(evt, fn) { (api.__handlers[evt] = api.__handlers[evt] || []).push(fn); } };
      if (process.env.RC_DEBUG) console.log('[AMap.Marker]', opts.clickable === false ? 'badge' : 'pin', String(opts.content && opts.content.innerHTML).slice(0, 50));
      calls.markers.push({ el: opts.content, isBadge: opts.clickable === false, api, opts });
      return api;
    },
    Polyline: function (opts) { calls.polylines.push({ path: opts.path, opts }); return { __opts: opts }; },
    LngLat: function (lng, lat) { return { lng, lat, getLng: () => lng, getLat: () => lat }; },
    Pixel: function (x, y) { return { x, y, getX: () => x, getY: () => y }; },
  };

  const documentStub = {
    getElementById: $, addEventListener() {}, body: { className: '' },
    createElement: (tag) => { const el = makeEl('new-' + tag); el.tagName = tag; return el; },
  };
  const windowStub = {
    ReactNativeWebView: { postMessage(msg) { calls.messages.push(msg); } },
    L, AMap: amapLoaded ? AMapStub : undefined,
    __rcDebug: !!process.env.RC_DEBUG,   // RC_DEBUG=1 时把被 safe() 吞掉的异常打出来
  };
  // 瓦片预热用的 Image 桩：只记下请求过的地址，不真的发请求
  class ImageStub { set src(v) { calls.images.push(v); } }

  let thrown = null;
  try {
    new Function(
      'document', 'window', 'L', 'AMap', 'setTimeout', 'clearTimeout', 'isFinite', 'Image', 'requestAnimationFrame',
      appScript
    )(
      documentStub, windowStub, L, amapLoaded ? AMapStub : undefined,
      // 长延时（>=1s）的回调在桩里不执行：真实运行中"出图看门狗 8s"会因为地图早就
      // complete 而不会触发，桩里直接跳过更贴近实际；需要验失败路径时单独跑
      (fn, ms) => { if (typeof fn === 'function' && !(ms >= 1000)) fn(); return 1; },
      () => {}, isFinite,
      ImageStub, (fn) => { if (typeof fn === 'function') fn(); }
    );
  } catch (e) {
    thrown = e;
  }
  return { html, calls, dom, $, windowStub, thrown };
}

/* ========================= 叶栅格 + 脏坐标 那一遍 ========================= */
const leaflet = bootMap({ points, segs, tdtKey: 'FAKE_KEY' });
const { calls, dom, $, windowStub, thrown } = leaflet;
const cardHtml = () => $('rcCard').innerHTML;
const messages = () => calls.messages.map((m) => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);

if (thrown) fail.push(`栅格脚本抛错：${thrown.message}`);
if (!dom.has('zin') || typeof $('zin').onclick !== 'function') fail.push('放大按钮没绑上 onclick');
if (!dom.has('zout') || typeof $('zout').onclick !== 'function') fail.push('缩小按钮没绑上 onclick');
if (!dom.has('tTraj') || typeof $('tTraj').onclick !== 'function') fail.push('轨迹开关没绑上 onclick');
if (!dom.has('tLoc') || typeof $('tLoc').onclick !== 'function') fail.push('标点开关没绑上 onclick');
if (!dom.has('zfull') || typeof $('zfull').onclick !== 'function') fail.push('全屏按钮没绑上 onclick');

const pins = calls.markers.filter((m) => !m.isBadge);
const badges = calls.markers.filter((m) => m.isBadge);
if (pins.length !== 2) fail.push(`标点数量应为 2（3 条合法记录，其中同坐标的两条要合并成 1 个），实际 ${pins.length}`);
if (badges.length !== 1) fail.push(`次数徽章应为 1（往返 2 次那条轨迹），实际 ${badges.length}`);
if (calls.polylines.length !== 1) fail.push(`轨迹数量应为 1（合法的一段），实际 ${calls.polylines.length}`);

$('zin').onclick?.();
$('zout').onclick?.();
if (calls.zoomIn !== 1 || calls.zoomOut !== 1) fail.push('点击缩放按钮没有触发地图缩放');

/* ------------------- 同一坐标的多条记录：合并成一个 + 数量角标 ------------------- */
const pinHtml = (m) => String((m.api.__state ? (m.api.__state.options.icon || {}).html : m.opts.content && m.opts.content.innerHTML) || '');
// 3 条合法记录里两条同坐标 → 只画 2 个标点；标点上不再挂「有几条记录」的数字角标
if (pins.some((m) => /<text/.test(pinHtml(m)))) fail.push('标点上不该再显示「这个地点有几条记录」的数字角标');
const mergedPin = pins[0];
const pin = mergedPin;

/* ------------------- 标点手势：单击看评论 / 双击放大飞过去 ------------------- */
if (!calls.mapOptions || calls.mapOptions.closePopupOnClick !== false) {
  fail.push('地图没有关闭 closePopupOnClick（会导致单击标点弹出的评论被立刻关掉）');
}
if (pins.some((m) => m.api.__state && m.api.__state.options.bubblingMouseEvents !== false)) {
  fail.push('标点没有关闭 bubblingMouseEvents（点击会冒泡给地图，评论同样会被关掉）');
}

// 直接走"绑在标点 DOM 上"的那条路（真机上的主路径）：pointerdown + pointerup
const domTap = (entry, x = 5, y = 5) => {
  const h = entry.el.__handlers || {};
  h.pointerdown?.forEach((fn) => fn({ clientX: x, clientY: y, stopPropagation() {}, preventDefault() {}, cancelable: true }));
  h.pointerup?.forEach((fn) => fn({ clientX: x, clientY: y, stopPropagation() {}, preventDefault() {}, cancelable: true }));
};
if (!pin.el.__handlers.pointerdown || !pin.el.__handlers.pointerup) {
  fail.push('标点没有绑定 DOM 手势（pointerdown/pointerup）');
}
// 等过双击判定窗口再点，确保这一下被当成"单击"
const singleTap = async () => { await wait(360); domTap(pin); };
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
domTap(pin);             // 第二下：判定为双击
if (calls.flyTo !== flyBefore2 + 1) fail.push('快速连点两次没有飞到该标点');
if ($('rcCard').style.display !== 'block') fail.push('双击后没有显示评论卡');
// ④ 放大级别：双击后的目标缩放不该超过 12（之前直接跳到 13，观感太冲）
if (calls.flyToZoom > 12) fail.push(`双击放大过度：目标缩放 ${calls.flyToZoom}`);

/* ------------------- 卡片翻页：一个标点上的多条记录左右切换 ------------------- */
// 上面第 ③ 步双击后卡片是开着的（第 1 条，共 2 条）
if (!/1\/2/.test(cardHtml())) fail.push(`多条记录的卡片应显示 1/2，实际：${cardHtml()}`);
if (!/data-detail="1"/.test(cardHtml())) fail.push('卡片默认应显示这个标点上最新的一条记录（id=1）');
if (typeof $('rcNext').onclick !== 'function' || typeof $('rcPrev').onclick !== 'function') {
  fail.push('多条记录的卡片没有绑定左右切换按钮');
} else {
  $('rcNext').onclick();
  if (!/2\/2/.test(cardHtml())) fail.push(`点「下一条」后应显示 2/2，实际：${cardHtml()}`);
  if (!/data-detail="11"/.test(cardHtml())) fail.push('翻页后「查看详情」应指向第二条记录（id=11）');
  $('rcNext').onclick();     // 首尾循环
  if (!/1\/2/.test(cardHtml()) || !/data-detail="1"/.test(cardHtml())) fail.push('翻到最后一条再点应回到第一条');
  $('rcPrev').onclick();
  if (!/2\/2/.test(cardHtml()) || !/data-detail="11"/.test(cardHtml())) fail.push('点「上一条」应回到最后一条（首尾循环）');
}

/* ---------------------------- 全屏（交给 RN 铺屏） ---------------------------- */
$('zfull').onclick();
const enter = messages().find((m) => m.type === 'mapFullscreen');
if (!enter) fail.push('点全屏按钮没有把 mapFullscreen 消息发给 RN');
else if (enter.on !== true) fail.push('点全屏按钮发出的 on 应为 true');

const api = windowStub.__rcMap;
if (!api || typeof api.setFullscreen !== 'function') {
  fail.push('地图没有暴露 __rcMap.setFullscreen（RN 侧无法同步全屏状态）');
} else {
  api.setFullscreen(true);
  const inFull = $('zfull').innerHTML;
  api.setFullscreen(false);
  const outFull = $('zfull').innerHTML;
  if (!/M9 4v5H4/.test(inFull)) fail.push('进入全屏后按钮图标没有换成「退出全屏」');
  if (!/M4 9V4h5/.test(outFull)) fail.push('退出全屏后按钮图标没有换回「进入全屏」');
}

/* ---------------------------- 缩放整帧与瓦片预热 ---------------------------- */
if (!calls.tileOptions.length) fail.push('栅格模式没有创建瓦片图层');
if (calls.tileOptions.some((t) => t.options.updateWhenZooming !== false)) {
  fail.push('瓦片图层没有关掉 updateWhenZooming（缩放动画期间会一直重算瓦片网格）');
}
if (!calls.tileOptions.every((t) => t.options.keepBuffer <= 3)) {
  fail.push('瓦片图层的 keepBuffer 偏大（屏幕外留的瓦片越多，合成越重）');
}
if (calls.doubleClickDisabled) fail.push('栅格模式把 Leaflet 的双击放大关掉了（双击空白处应该能放大一级）');

/* ======================= 高德栅格底图（不需要 key）那一遍 ======================= */
/* ============ 同名地点合并 + 出行方式筛选 + 胶囊命中区（栅格） ============ */

// 同名、坐标差出一大截的地点：应当并成一根针，落点取记录数最多的那一簇
const nameMerge = bootMap({
  points: [
    { id: 21, kind: 'location', title: '外滩', date: '2023-01-01', note: '只来过一次', lat: 31.24, lng: 121.49 },
    { id: 22, kind: 'location', title: '外滩', date: '2023-02-01', note: '', lat: 31.2304, lng: 121.4737 },
    { id: 23, kind: 'location', title: '外滩', date: '2023-03-01', note: '', lat: 31.23041, lng: 121.47372 },
    { id: 24, kind: 'location', title: ' 外滩 ', date: '2023-04-01', note: '带着空格的名字也算同一个', lat: 31.23042, lng: 121.47373 },
    // 旅票的出发地/目的地同样按名字合并：两条「北京南」落在近处、一条落在远处
    { id: 25, kind: 'ticket', subType: 'train', title: '北京南', date: '2023-05-01', note: '', lat: 39.8652, lng: 116.3785 },
    { id: 26, kind: 'ticket', subType: 'train', title: '北京南', date: '2023-06-01', note: '', lat: 39.86521, lng: 116.37851 },
    { id: 27, kind: 'ticket', subType: 'train', title: '北京南', date: '2023-07-01', note: '', lat: 39.90, lng: 116.42 },
  ],
  segs: [],
});
if (nameMerge.thrown) fail.push(`同名合并那一遍脚本抛错：${nameMerge.thrown.message}`);
{
  const mPins = nameMerge.calls.markers.filter((m) => !m.isBadge);
  // 两个名字（外滩 / 北京南）各并成一根针：地点 4 条 + 旅票 3 条
  if (mPins.length !== 2) fail.push(`同名地点（含旅票起终点）应当并成 2 根针，实际 ${mPins.length}`);
  const at = mPins[0] && mPins[0].ll;
  if (at && (Math.abs(at[0] - 31.2304) > 1e-6 || Math.abs(at[1] - 121.4737) > 1e-6)) {
    fail.push(`同名地点的落点应取记录最多的那一簇（31.2304,121.4737），实际 ${JSON.stringify(at)}`);
  }
  const trainPin = mPins[1] && mPins[1].ll;
  if (trainPin && (Math.abs(trainPin[0] - 39.8652) > 1e-6 || Math.abs(trainPin[1] - 116.3785) > 1e-6)) {
    fail.push(`旅票同名地点也应按记录最多的那一簇合并（39.8652,116.3785），实际 ${JSON.stringify(trainPin)}`);
  }
  // 点开这根针：4 条同名记录都挂在一起，能左右翻
  const mp = mPins[0];
  nameMerge.$('rcCard').style.display = 'none';
  domTap(mp);
  if (nameMerge.$('rcCard').style.display !== 'block') fail.push('同名合并后的标点单击没有弹出内容卡');
  if (!/1\/4/.test(nameMerge.$('rcCard').innerHTML)) {
    fail.push(`同名合并后的卡片应显示 1/4（4 条同名记录都挂在同一根针上），实际：${nameMerge.$('rcCard').innerHTML}`);
  }
}

// 出行方式筛选：飞机 / 火车两类各一条轨迹，逐个关掉
const filt = bootMap({
  points: [
    { id: 31, kind: 'ticket', subType: 'flight', title: '虹桥', date: '2023-05-01', note: '', lat: 31.19, lng: 121.32 },
    { id: 32, kind: 'ticket', subType: 'train', title: '北京南', date: '2023-05-02', note: '', lat: 39.865, lng: 116.378 },
  ],
  segs: [
    { from: { name: 'A', longitude: 116.4, latitude: 39.9 }, to: { name: 'B', longitude: 121.32, latitude: 31.19 }, count: 1, subType: 'flight' },
    { from: { name: 'A', longitude: 116.4, latitude: 39.9 }, to: { name: 'C', longitude: 113.3, latitude: 23.1 }, count: 1, subType: 'train' },
  ],
});
if (filt.thrown) fail.push(`出行方式筛选那一遍脚本抛错：${filt.thrown.message}`);
{
  const fPins = () => filt.calls.markers.filter((m) => !m.isBadge).length;
  if (filt.calls.polylines.length !== 2 || fPins() !== 2) {
    fail.push(`默认四类全开时应画 2 条轨迹 / 2 个起终点，实际 ${filt.calls.polylines.length} / ${fPins()}`);
  }
  // 轨迹开着时，筛选胶囊那一排要显示出来
  if (filt.$('trajFilter').style.display !== 'flex') fail.push('轨迹默认开着时出行方式筛选没有显示');
  // 桩的图层 clear() 不会真的清掉记录，所以按"重画出来几条"的增量来判断
  const segDelta = (fn) => {
    const before = filt.calls.polylines.length;
    const beforePins = fPins();
    fn();
    return { lines: filt.calls.polylines.length - before, pins: fPins() - beforePins };
  };
  // 关掉「火车」→ 重画时只剩飞机那一类
  if (typeof filt.$('tf_train').onclick !== 'function') fail.push('出行方式胶囊（火车）没有绑上 onclick');
  const dTrainOff = segDelta(() => filt.$('tf_train').onclick({ clientX: 20, clientY: 14 }));
  if (dTrainOff.lines !== 1 || dTrainOff.pins !== 1) {
    fail.push(`关掉火车后应只重画 1 条飞机轨迹 / 1 个点，实际 ${dTrainOff.lines} / ${dTrainOff.pins}`);
  }
  if (!/火车轨迹：隐藏/.test(filt.$('toast').textContent)) {
    fail.push(`关掉出行方式后没有提示，实际：${filt.$('toast').textContent}`);
  }
  // 点胶囊圆角外面那块不算点到按钮（命中区按跑道形状判）
  const dCorner = segDelta(() => filt.$('tf_flight').onclick({ clientX: 1, clientY: 1 }));
  if (dCorner.lines !== 0) fail.push('点出行方式胶囊的圆角外侧不该触发筛选');
  // 把剩下三类也关掉 → 一条轨迹都不画，并给出提示
  const dAllOff = segDelta(() => {
    filt.$('tf_flight').onclick({ clientX: 20, clientY: 14 });
    filt.$('tf_bus').onclick({ clientX: 20, clientY: 14 });
    filt.$('tf_ship').onclick({ clientX: 20, clientY: 14 });
  });
  if (dAllOff.lines !== 0 || dAllOff.pins !== 0) {
    fail.push(`四类全关掉后不该再画轨迹，实际重画了 ${dAllOff.lines} 条 / ${dAllOff.pins} 个点`);
  }
  if (!/四种出行方式都关掉了/.test(filt.$('hint').innerHTML)) {
    fail.push('四类全关掉后没有给出「都关掉了」的提示');
  }
  // 轨迹开关：点跑道圆角外侧不算点到，点中间才算
  const toastBefore = filt.$('toast').textContent;
  filt.$('tTraj').onclick({ clientX: 1, clientY: 1 });
  if (filt.$('toast').textContent !== toastBefore) fail.push('点「轨迹」胶囊的圆角外侧不该触发开关');
  // 只把「火车」打开（轨迹还开着）→ 重画 1 条
  const dTrainOn = segDelta(() => filt.$('tf_train').onclick({ clientX: 20, clientY: 14 }));
  if (dTrainOn.lines !== 1 || dTrainOn.pins !== 1) {
    fail.push(`只打开火车时应重画 1 条轨迹 / 1 个点，实际 ${dTrainOn.lines} / ${dTrainOn.pins}`);
  }
  // 关掉轨迹 → 不画；筛选选择要保留
  const dTrajOff = segDelta(() => filt.$('tTraj').onclick({ clientX: 20, clientY: 14 }));
  if (!/出行轨迹：关/.test(filt.$('toast').textContent)) fail.push('点「轨迹」胶囊中间没有关掉轨迹');
  if (dTrajOff.lines !== 0) fail.push('关掉轨迹后不该再画轨迹');
  if (filt.$('trajFilter').style.display !== 'none') fail.push('关掉轨迹后出行方式筛选应当收起');
  // 再点开：面板回来，按保留下来的筛选（只有火车）重画
  const dTrajBack = segDelta(() => filt.$('tTraj').onclick({ clientX: 20, clientY: 14 }));
  if (!/出行轨迹：开/.test(filt.$('toast').textContent)) fail.push('再点一次「轨迹」没有重新打开');
  if (filt.$('trajFilter').style.display !== 'flex') fail.push('重新打开轨迹后出行方式筛选应当再出现');
  if (dTrajBack.lines !== 1) fail.push(`重开轨迹后应按保留的筛选只画火车，实际 ${dTrajBack.lines} 条`);
  // 再把「飞机」打开 → 两类都画
  const dBoth = segDelta(() => filt.$('tf_flight').onclick({ clientX: 20, clientY: 14 }));
  if (dBoth.lines !== 2) fail.push(`飞机也打开后应重画 2 条轨迹，实际 ${dBoth.lines}`);
}

/* ======================= 高德栅格底图（不需要 key）那一遍 ======================= */
// 旧版预热开头就是「没 key 就直接 return」，高德用户没填 key 时等于一张都不预热。
const amapRaster = bootMap({
  points: [{ id: 1, kind: 'location', title: '外滩', date: '2023-10-02', note: '', lat: 31.2304, lng: 121.4737 }],
  segs: [], tdtKey: '', provider: 'amap',
});
if (amapRaster.thrown) fail.push(`高德栅格脚本抛错：${amapRaster.thrown.message}`);
if (!amapRaster.calls.tileOptions.some((t) => /autonavi\.com/.test(String(t.url)))) {
  fail.push('provider=amap 且没填 JS API key 时应当用高德栅格瓦片');
}
amapRaster.calls.mapHandlers.zoomstart?.forEach((fn) => fn());
const prefetched = amapRaster.calls.images.filter((u) => /autonavi\.com/.test(u));
if (prefetched.length === 0) {
  fail.push('高德栅格底图没有预热下一级瓦片（没填 key 时也要预热）');
}
if (/未配置天地图 Key/.test(amapRaster.$('banner').textContent)) {
  fail.push('高德底图不该提示「未配置天地图 Key」');
}

/* =============== 高德 JS API 2.0（矢量）那一遍 =============== */
const jsapi = bootMap({ points, segs, provider: 'amap', jsApiKey: 'JS-KEY-123', securityCode: 'SEC-456', dark: true });
if (jsapi.thrown) fail.push(`矢量脚本抛错：${jsapi.thrown.message}`);
if (jsapi.html.includes('leaflet.min.js') || /function \(t\) \{/.test(jsapi.html)) {
  // 不该注入 Leaflet（脚本里带 stub 注释也算注入了）
  if (jsapi.html.includes('/* stub */')) fail.push('矢量模式不该再内联 Leaflet');
}
if (!/webapi\.amap\.com\/maps\?v=2\.0&key=JS-KEY-123/.test(jsapi.html)) {
  fail.push('矢量模式没有按 key 加载高德 JS API');
}
if (!/securityJsCode:\s*"SEC-456"|securityJsCode":\s*"SEC-456"/.test(jsapi.html)) {
  fail.push('矢量模式没有把安全密钥写进 _AMapSecurityConfig');
}
const ao = jsapi.calls.amapMapOptions;
if (!ao) fail.push('矢量模式没有创建 AMap.Map');
else {
  if (ao.mapStyle !== 'amap://styles/dark') fail.push(`深色下应当用官方深色样式，实际 ${ao.mapStyle}`);
  if (ao.doubleClickZoom === false) fail.push('矢量模式关掉了双击放大（双击空白处应该能放大一级）');
  if (ao.resizeEnable !== true) fail.push('高德地图没有打开 resizeEnable（全屏/转屏后尺寸不会跟）');
}
if (!jsapi.calls.tileOptions.length === false) { /* 矢量模式不建瓦片图层，这里不做断言 */ }
if (jsapi.calls.tileOptions.length) fail.push('矢量模式不该再自己加瓦片图层');
const jPins = jsapi.calls.markers.filter((m) => !m.isBadge);
const jBadges = jsapi.calls.markers.filter((m) => m.isBadge);
if (jPins.length !== 2) fail.push(`矢量模式标点数量应为 2，实际 ${jPins.length}`);
if (jBadges.length !== 1) fail.push(`矢量模式次数徽章应为 1，实际 ${jBadges.length}`);
if (jPins.some((m) => /<text/.test(String(m.opts.content.innerHTML)))) {
  fail.push('矢量模式标点上不该再显示记录条数角标');
}
const jMerged = jPins[0];
if (!jsapi.calls.polylines.length) fail.push('矢量模式没有画轨迹线');
else {
  const path = jsapi.calls.polylines[0].path;
  // AMap 的 path 是 [lng, lat]：第一位应当是经度（>90），不能把纬度放前面
  if (!(path[0][0] > 90 && path[0][1] < 50)) {
    fail.push(`矢量模式轨迹坐标顺序不对（应是 [lng,lat]）：${JSON.stringify(path[0])}`);
  }
}
// 矢量模式下点标点 → 走同一套卡片逻辑（内容元素上绑的 DOM 手势）
if (jMerged) {
  jsapi.$('rcCard').style.display = 'none';
  domTap(jMerged);
  if (jsapi.$('rcCard').style.display !== 'block') fail.push('矢量模式单击标点没有弹出内容卡');
  if (!/1\/2/.test(jsapi.$('rcCard').innerHTML)) fail.push('矢量模式内容卡没有显示 1/2');
  jsapi.$('rcNext').onclick?.();
  if (!/2\/2/.test(jsapi.$('rcCard').innerHTML)) fail.push('矢量模式内容卡不能左右翻记录');
}
jsapi.$('zin').onclick?.();
jsapi.$('zfull').onclick?.();
const jMsgs = jsapi.calls.messages.map((m) => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);
if (!jMsgs.some((m) => m.type === 'mapFullscreen')) fail.push('矢量模式全屏按钮没有给 RN 发消息');
if (jMsgs.some((m) => m.type === 'jsApiFailed')) fail.push('矢量模式正常出图时不该报 jsApiFailed');

/* =============== 矢量模式加载失败 → 通知 RN 回退 =============== */
const jsFail = bootMap({ points, segs, provider: 'amap', jsApiKey: 'JS-KEY-123', securityCode: 'SEC-456', amapLoaded: false });
if (jsFail.thrown) fail.push(`矢量失败路径抛错：${jsFail.thrown.message}`);
const fMsgs = jsFail.calls.messages.map((m) => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);
if (!fMsgs.some((m) => m.type === 'jsApiFailed')) {
  fail.push('高德 JS API 没加载出来时没有通知 RN 回退（会一直白屏）');
}

const droppedShown = /坐标不完整/.test($('banner').textContent);

console.log(`栅格：标点 ${pins.length} 个（含 1 个合并了 2 条记录的标点），次数徽章 ${badges.length} 个，轨迹 ${calls.polylines.length} 段，缩放调用 ${calls.zoomIn}/${calls.zoomOut}`);
console.log(`卡片分页：${/1\/2/.test(cardHtml()) || /2\/2/.test(cardHtml()) ? '左右切换可用' : '未生效'}`);
console.log(`全屏消息：${enter ? JSON.stringify(enter) : '（未发出）'}`);
console.log(`高德栅格预热瓦片：${prefetched.length} 张`);
console.log(`矢量模式：标点 ${jPins.length} 个 / 轨迹 ${jsapi.calls.polylines.length} 段 / 样式 ${ao && ao.mapStyle}`);
console.log(`矢量失败回退：${fMsgs.filter((m) => m.type === 'jsApiFailed').length ? '已通知 RN' : '未通知'}`);
console.log(`手势自检：单击开评论 / 再点收起 / 连点两次 flyTo（共 ${calls.flyTo} 次飞点）`);
console.log(`脏坐标提示：${droppedShown ? $('banner').textContent : '（未显示）'}`);
console.log(`同名落点（数据侧）：${anchorSummary}`);
console.log(`同名合并（渲染侧）：${nameMerge.calls.markers.filter((m) => !m.isBadge).length} 根针（外滩 4 条 + 旅票「北京南」3 条）`);
console.log(`出行方式筛选：关掉火车后只画飞机、四类全关后不画线、开关轨迹后筛选状态保留 / 胶囊圆角外不响应`);
if (fail.length) {
  console.error('✗ 自检未通过：\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log('✓ 通过：脏坐标被跳过；同名落点（地点印记 + 旅票起终点）取记录最多的那一簇；栅格与矢量两条路都正常绘制；合并标点（同坐标 + 同名）/ 卡片翻页 / 全屏 / 出行方式筛选 / 胶囊命中区 / 失败回退都可用');
