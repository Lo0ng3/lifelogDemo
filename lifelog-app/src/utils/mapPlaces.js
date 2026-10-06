// 地图上的地名归一与「同名落点」计算（纯函数，可在 node 里直接跑）。
//
// 背景：同一个地方常常带着好几个坐标——检索结果和照片 GPS 有几米到几百米的差异，
// 或者同一个地方手输过两次。地图要"一个地方一根针"，就得先给每个名字定一个落点：
//   1) 名字归一：去掉结尾的「国际机场 / 机场」、去掉所有空白、统一小写；
//      老数据里的「未命名记录」这种占位不算名字（否则所有没名字的印记会并到一根针上）；
//   2) 把地点印记的坐标、旅票的出发地 / 目的地坐标都按名字聚成坐标簇（4 位小数 ≈ 11 米）；
//   3) 取**记录最多的那一簇**作为这个名字的落点。
// 标点和轨迹弧线都用这个落点，线才会正好连到针上；用全量记录算（不是当前筛选结果），
// 切换筛选时同一地点的位置不会跳。地图 HTML 里还有一层同样的兜底合并（见 mapHtml.js）。
import { shortPlaceName } from './format';

// 坐标统一成有限数字：字符串 / 缺失 / 异常值一律当没有坐标
// （引擎的 LatLng 遇到 NaN 会直接抛错，把后面的绘制和控件绑定全带崩）
export const toCoord = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// { latitude, longitude }（字段名可换）→ { lat, lng }；缺一个就当没有坐标
export const latLngOfPoint = (p, latKey = 'latitude', lngKey = 'longitude') => {
  const lat = toCoord(p?.[latKey]), lng = toCoord(p?.[lngKey]);
  return lat == null || lng == null ? null : { lat, lng };
};

// 没有名字的地点用的占位标题（老数据）：不参与同名合并
const PLACEHOLDER_PLACE_NAMES = new Set(['未命名记录', '未命名']);

// 地名归一：同一个 key 就是"同一个地方"
export const placeKeyOf = (name) => {
  const short = shortPlaceName(String(name || '').trim()) || '';
  const key = String(short).replace(/\s+/g, '').toLowerCase();
  return PLACEHOLDER_PLACE_NAMES.has(key) ? '' : key;
};

// 名字 → 落点 { lat, lng }。地点印记取 title + coordinates，旅票取 start / end
// （旅票的 title 是「A → B」，不能当地名用，所以只看 baseType === 'location' 的 title）
export const buildPlaceAnchors = (logs = []) => {
  const clusters = new Map();     // 名字 → Map(坐标簇 → { lat, lng, count })
  const add = (name, at) => {
    const key = placeKeyOf(name);
    if (!key || !at) return;
    let byCoord = clusters.get(key);
    if (!byCoord) { byCoord = new Map(); clusters.set(key, byCoord); }
    const ck = `${at.lat.toFixed(4)},${at.lng.toFixed(4)}`;
    const hit = byCoord.get(ck);
    if (hit) hit.count++;
    else byCoord.set(ck, { lat: at.lat, lng: at.lng, count: 1 });
  };
  for (const item of logs || []) {
    if (!item) continue;
    if (item.baseType === 'location') add(item.title, latLngOfPoint(item.coordinates));
    add(item.start?.name, latLngOfPoint(item.start));
    add(item.end?.name, latLngOfPoint(item.end));
  }
  const anchors = new Map();
  clusters.forEach((byCoord, key) => {
    let best = null;
    byCoord.forEach(c => { if (!best || c.count > best.count) best = c; });
    if (best) anchors.set(key, { lat: best.lat, lng: best.lng });
  });
  return anchors;
};

// 取某个名字的落点；这个名字没记录过就退回它自己的坐标
export const anchorOf = (anchors, name, at) => {
  const key = placeKeyOf(name);
  return (key && anchors?.get(key)) || at;
};
