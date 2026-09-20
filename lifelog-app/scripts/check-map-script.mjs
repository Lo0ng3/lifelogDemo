// 地图脚本回归自检（不需要真机/网络）：
// 把 mapHtml 生成的那段脚本分别用「桩 Leaflet」和「桩 AMap」跑一遍，验证
//   ① 脏坐标（缺失 / NaN / 字符串异常）不会让整段脚本抛错；
//   ② 缩放、轨迹/标点开关、全屏按钮的 onclick 一定绑上了；
//   ③ 合法标点照常创建；
//   ④ 同一坐标的多条记录合成一个标点（角标写条数），卡片能左右翻记录；
//   ⑤ 全屏按钮把「进/退全屏」发给 RN，RN 回调后按钮图标会换；
//   ⑥ 栅格模式：缩放动画期间不重算瓦片网格，高德底图（不需要 key）也会预热下一级瓦片；
//   ⑦ 矢量模式（高德 JS API 2.0）：按 key/安全密钥正确初始化、深色走官方深色样式、
//      标点与轨迹用 AMap 的坐标顺序画出来、出图失败会给 RN 发 jsApiFailed 以便回退。
//
// 背景：1.6.6 的「地图能显示、标点不显示、放大缩小点了没反应」就是 ① 的反面——
// 引擎的 LatLng 遇到 undefined 会抛错，后面的绘制和控件绑定全被打断。
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
const mergedPin = pins.find((m) => pinHtml(m).includes('>2<'));
if (!mergedPin) fail.push('同一个地点的两条记录没有合并出「角标 2」的标点');
if (pins.some((m) => pinHtml(m).includes('>1<'))) fail.push('单条记录的标点不该出现数字角标');
const pin = (mergedPin || pins[0]);

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
  if (ao.doubleClickZoom !== false) fail.push('高德地图没有关掉双击放大（双击要留给"飞到标点"）');
  if (ao.resizeEnable !== true) fail.push('高德地图没有打开 resizeEnable（全屏/转屏后尺寸不会跟）');
}
if (!jsapi.calls.tileOptions.length === false) { /* 矢量模式不建瓦片图层，这里不做断言 */ }
if (jsapi.calls.tileOptions.length) fail.push('矢量模式不该再自己加瓦片图层');
const jPins = jsapi.calls.markers.filter((m) => !m.isBadge);
const jBadges = jsapi.calls.markers.filter((m) => m.isBadge);
if (jPins.length !== 2) fail.push(`矢量模式标点数量应为 2，实际 ${jPins.length}`);
if (jBadges.length !== 1) fail.push(`矢量模式次数徽章应为 1，实际 ${jBadges.length}`);
const jMerged = jPins.find((m) => String(m.opts.content.innerHTML).includes('>2<'));
if (!jMerged) fail.push('矢量模式没有合并出「角标 2」的标点');
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
if (fail.length) {
  console.error('✗ 自检未通过：\n- ' + fail.join('\n- '));
  process.exit(1);
}
console.log('✓ 通过：脏坐标被跳过；栅格与矢量两条路都正常绘制，合并标点 / 卡片翻页 / 全屏 / 失败回退都可用');
