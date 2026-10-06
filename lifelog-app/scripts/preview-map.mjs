// 生成本地地图预览页（浅色 + 深色），用于在浏览器里检查标点、轨迹、控件与弹窗。
// 用法：node scripts/preview-map.mjs [--key=天地图Key] [--provider=amap]
//       [--jsapi-key=高德Web端Key --jsapi-code=安全密钥]
// 不给 Key 时预览页用 OSM 底图顶上，方便直接看出标点位置（App 内仍走天地图）
// 产物：demo/map-preview-light.html、demo/map-preview-dark.html
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// 源码是给 metro 看的 ESM-in-.js：复制成 .mjs 后 node 才能直接 import
const scratch = mkdtempSync(join(tmpdir(), 'rc-preview-'));
const asModule = async (relPath) => {
  const target = join(scratch, basename(relPath).replace(/\.js$/, '.mjs'));
  copyFileSync(join(root, relPath), target);
  return import(pathToFileURL(target).href);
};
// 带相对依赖的源码（mapPlaces → format）：复制时补上 .mjs 后缀，node 才解析得了
const asModuleWithDeps = async (relPath, deps = []) => {
  const copy = (rel) => {
    const code = readFileSync(join(root, rel), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.mjs'");
    const target = join(scratch, basename(rel).replace(/\.js$/, '.mjs'));
    writeFileSync(target, code);
    return target;
  };
  deps.forEach(copy);
  return import(pathToFileURL(copy(relPath)).href);
};

const { buildMapHtml } = await asModule('src/utils/mapHtml.js');
const { palettes } = await asModule('src/theme/palette.js');
const { shortPlaceName } = await asModule('src/utils/format.js');
const { buildPlaceAnchors, anchorOf, latLngOfPoint } = await asModuleWithDeps('src/utils/mapPlaces.js', ['src/utils/format.js']);

// 预览页自带样例数据（App 里的种子数据是空的，分享版不塞示例行程）
const initialLogData = [
  { id: 1, baseType: 'ticket', subType: 'flight', title: '北京 → 上海', subtitle: 'MU5101', date: '2023-10-01',
    start: { name: '北京首都国际机场', longitude: 116.5971, latitude: 40.0723 },
    end: { name: '上海虹桥国际机场', longitude: 121.3363, latitude: 31.1972 } },
  { id: 2, baseType: 'location', subType: 'location', title: '外滩 & 南京东路', subtitle: '风很大，夜景绝美', date: '2023-10-02',
    coordinates: { latitude: 31.2304, longitude: 121.4737 } },
  { id: 3, baseType: 'location', subType: 'location', title: 'Luneurs 咖啡馆', subtitle: '拿铁很棒', date: '2023-10-04',
    coordinates: { latitude: 31.2155, longitude: 121.4335 } },
  { id: 4, baseType: 'ticket', subType: 'train', title: '上海虹桥 → 北京南', subtitle: 'G1', date: '2023-10-07',
    start: { name: '上海虹桥站', longitude: 121.3205, latitude: 31.1946 },
    end: { name: '北京南站', longitude: 116.3785, latitude: 39.8652 } },
  { id: 10, baseType: 'ticket', subType: 'flight', title: '广州 → 曼谷', subtitle: 'CZ3081', date: '2025-03-15',
    start: { name: '广州白云国际机场', longitude: 113.3024, latitude: 23.3924 },
    end: { name: '素万那普国际机场', longitude: 100.7470, latitude: 13.6900 } },
  // 同一个地点的第二条记录：预览页里应当并成"角标 2"的一个标点，点开后能左右翻
  { id: 20, baseType: 'location', subType: 'location', title: '外滩 · 跨年', subtitle: '人山人海', date: '2024-01-01',
    coordinates: { latitude: 31.2304, longitude: 121.4737 } },
  // 同名但坐标差出一截（照片 GPS 抖出来的那种）：应当并到上面那根针上，落点取记录多的那一簇
  { id: 22, baseType: 'location', subType: 'location', title: '外滩', subtitle: '从北边走过来', date: '2024-03-02',
    coordinates: { latitude: 31.2380, longitude: 121.4900 } },
  // 和上面那条航班的出发机场同一个坐标：旅票起点 + 地点记录也会并到同一个标点上
  { id: 21, baseType: 'location', subType: 'location', title: '首都机场 T3 接机', subtitle: '等了两个小时', date: '2024-02-10',
    coordinates: { latitude: 40.0723, longitude: 116.5971 } },
];

const leafletJs = read('vendor/leaflet/leaflet.min.js');
const leafletCss = read('vendor/leaflet/leaflet.min.css');

const keyArg = process.argv.find((a) => a.startsWith('--key='));
const tdtKey = keyArg ? keyArg.slice('--key='.length).trim() : (process.env.TDT_KEY || '');
// 服务商：--provider=amap 用高德街道（不需要 key）；默认天地图
const providerArg = process.argv.find((a) => a.startsWith('--provider='));
const provider = providerArg ? providerArg.slice('--provider='.length).trim() : 'tianditu';
// 矢量渲染预览：给了 JS API key 就走高德官方 SDK（浏览器里也能开，和 App 内同一份 HTML）
const jsKeyArg = process.argv.find((a) => a.startsWith('--jsapi-key='));
const jsCodeArg = process.argv.find((a) => a.startsWith('--jsapi-code='));
const jsApiKey = jsKeyArg ? jsKeyArg.slice('--jsapi-key='.length).trim() : '';
const securityCode = jsCodeArg ? jsCodeArg.slice('--jsapi-code='.length).trim() : '';
const useJsApi = provider === 'amap' && !!jsApiKey;
// 天地图没给 Key 的预览页补一层 OSM 瓦片，不然浏览器里只有底色和标点，看不出地理位置关系
const osmFallback = (tdtKey || provider === 'amap') ? '' : `
<script>
  if (window.__rcMap && window.__rcMap.map && window.L) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(window.__rcMap.map);
  }
</script>`;

// 用真实的数据结构拼出打点与轨迹（与 HomeScreen 里的逻辑一致：同名地点先归到统一的落点）
const placeAnchors = buildPlaceAnchors(initialLogData);
const anchorFor = (name, at) => anchorOf(placeAnchors, name, at);
const points = [];
initialLogData.forEach((item) => {
  const note = item.comment || item.subtitle || '';
  const location = latLngOfPoint(item.coordinates);
  if (location) {
    const at = anchorFor(item.title, location);
    points.push({ id: item.id, kind: 'location', title: item.title, date: item.date, note, lat: at.lat, lng: at.lng });
  }
  [item.start, item.end].forEach((p) => {
    const at = anchorFor(p?.name, latLngOfPoint(p));
    if (at) {
      points.push({ id: item.id, kind: 'ticket', subType: item.subType, title: shortPlaceName(p.name || item.title), date: item.date, note, lat: at.lat, lng: at.lng });
    }
  });
});
const segMap = new Map();
initialLogData
  .filter((t) => t.baseType === 'ticket' && latLngOfPoint(t.start) && latLngOfPoint(t.end))
  .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  .forEach((t) => {
    const fromAt = anchorFor(t.start?.name, latLngOfPoint(t.start));
    const toAt = anchorFor(t.end?.name, latLngOfPoint(t.end));
    const from = { name: t.start?.name || '', longitude: fromAt.lng, latitude: fromAt.lat };
    const to = { name: t.end?.name || '', longitude: toAt.lng, latitude: toAt.lat };
    const key = [from, to].map((p) => p.longitude.toFixed(4) + ',' + p.latitude.toFixed(4)).join('→');
    if (!segMap.has(key)) segMap.set(key, { from, to, count: 0, subType: t.subType });
    const seg = segMap.get(key);
    seg.count++;
    seg.from = from; seg.to = to;
  });
const segs = [...segMap.values()];

mkdirSync(join(root, 'demo'), { recursive: true });
for (const scheme of ['light', 'dark']) {
  const html = buildMapHtml({
    points,
    segs,
    tdtKey,
    provider,
    jsApiKey,
    securityCode,
    dark: scheme === 'dark',
    colors: palettes[scheme].map,
    leafletJs: useJsApi ? '' : leafletJs,
    leafletCss: useJsApi ? '' : leafletCss,
  }).replace('</body>', `${osmFallback}</body>`);
  const suffix = provider === 'amap' ? (useJsApi ? '-amap-jsapi' : '-amap') : '';
  const out = join(root, `demo/map-preview-${scheme}${suffix}.html`);
  writeFileSync(out, html, 'utf8');
  console.log(`已生成 ${out}（${points.length} 个标点 / ${segs.length} 段轨迹${useJsApi ? '，高德 JS API 矢量渲染' : ''}）`);
}
