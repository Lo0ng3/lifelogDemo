// 生成本地地图预览页（浅色 + 深色），用于在浏览器里检查标点、轨迹、控件与弹窗。
// 用法：node scripts/preview-map.mjs [--key=天地图Key]
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

const { buildMapHtml } = await asModule('src/utils/mapHtml.js');
const { palettes } = await asModule('src/theme/palette.js');

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
];

const leafletJs = read('vendor/leaflet/leaflet.min.js');
const leafletCss = read('vendor/leaflet/leaflet.min.css');

const keyArg = process.argv.find((a) => a.startsWith('--key='));
const tdtKey = keyArg ? keyArg.slice('--key='.length).trim() : (process.env.TDT_KEY || '');
// 服务商：--provider=amap 用高德街道（不需要 key）；默认天地图
const providerArg = process.argv.find((a) => a.startsWith('--provider='));
const provider = providerArg ? providerArg.slice('--provider='.length).trim() : 'tianditu';
// 天地图没给 Key 的预览页补一层 OSM 瓦片，不然浏览器里只有底色和标点，看不出地理位置关系
const osmFallback = (tdtKey || provider === 'amap') ? '' : `
<script>
  if (window.__rcMap && window.__rcMap.map && window.L) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(window.__rcMap.map);
  }
</script>`;

// 用真实的数据结构拼出打点与轨迹（与 HomeScreen 里的逻辑一致）
const shortPlaceName = (name) => String(name || '').replace(/(国际)?(机场|站)$/, '');
const points = [];
initialLogData.forEach((item) => {
  const note = item.comment || item.subtitle || '';
  if (item.coordinates && item.coordinates.latitude != null) {
    points.push({ id: item.id, kind: 'location', title: item.title, date: item.date, note, lat: item.coordinates.latitude, lng: item.coordinates.longitude });
  }
  [item.start, item.end].forEach((p) => {
    if (p && p.latitude != null && p.longitude != null) {
      points.push({ id: item.id, kind: 'ticket', subType: item.subType, title: shortPlaceName(p.name || item.title), date: item.date, note, lat: p.latitude, lng: p.longitude });
    }
  });
});
const segMap = new Map();
initialLogData
  .filter((t) => t.baseType === 'ticket' && t.start && t.end && t.start.latitude != null && t.end.latitude != null)
  .forEach((t) => {
    const key = [t.start, t.end].map((p) => p.longitude.toFixed(4) + ',' + p.latitude.toFixed(4)).join('→');
    if (!segMap.has(key)) segMap.set(key, { from: t.start, to: t.end, count: 0, subType: t.subType });
    const seg = segMap.get(key);
    seg.count++;
    seg.from = t.start; seg.to = t.end;
  });
const segs = [...segMap.values()];

mkdirSync(join(root, 'demo'), { recursive: true });
for (const scheme of ['light', 'dark']) {
  const html = buildMapHtml({
    points,
    segs,
    tdtKey,
    provider,
    colors: palettes[scheme].map,
    leafletJs,
    leafletCss,
  }).replace('</body>', `${osmFallback}</body>`);
  const suffix = provider === 'amap' ? `-amap` : '';
  const out = join(root, `demo/map-preview-${scheme}${suffix}.html`);
  writeFileSync(out, html, 'utf8');
  console.log(`已生成 ${out}（${points.length} 个标点 / ${segs.length} 段轨迹）`);
}
