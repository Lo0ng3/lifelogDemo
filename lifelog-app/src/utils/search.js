// 智能补全的检索源：
// - 影视/动漫/书籍：豆瓣联想接口（国内直连、免密钥、带海报）
// - 游戏：Steam 商店搜索（免密钥、国区可直连、带竖版封面）
// - 地点：iOS 固定使用苹果原生 MapKit，Android 可选天地图 / 高德

import { Platform } from 'react-native';
import { gcj02ToWgs84 } from './coord';
import { hasAppleMapSearch, searchApplePlacesAsync, geocodeApplePlaceAsync } from './appleMap';

const DOUBAN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// 网络请求统一 8 秒超时：挂死的请求不再阻塞联想/封面回填流程。
// 超时只让调用方尽快失败，底层请求会随调用方的 AbortSignal 或 GC 结束
export const withTimeout = (promise, ms = 8000) => {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms));
  promise.catch(() => {}); // 超时先到时，落选方之后的拒绝不再触发未处理警告
  return Promise.race([promise, timeout]);
};

// 豆瓣海报与 Steam library_600x900 统一为竖版 2:3
const DOUBAN_POSTER_RATIO = 2 / 3;
const doubanHostBySubType = { movie: 'movie', tv: 'movie', anime: 'movie', book: 'book' };

// 地点联想 / 地理编码：
// - iOS：固定使用苹果原生 MapKit（免密钥、国内直连高德 POI 库，坐标为 GCJ-02，入库前转 WGS-84）
// - Android：天地图（WGS-84）或高德（GCJ-02 转回 WGS-84）
export const hasLocationSearch = (loc) => (
  (Platform.OS === 'ios' && hasAppleMapSearch) || !!loc?.key
);
export const locationProviderLabel = (loc) => (
  Platform.OS === 'ios' || loc?.provider === 'apple' ? '苹果地图' : (loc?.provider === 'amap' ? '高德' : '天地图')
);

// 天地图 API 在华为云 WAF 后面：非浏览器 User-Agent（如 RN 的 okhttp）会被 403，统一伪装成浏览器
const TDT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

const parseLonlat = (s) => {
  if (!s) return null;
  const [lng, lat] = String(s).split(',').map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
};

// 地名输入联想。返回 [{ name, district, lng, lat, isPrompt }]
export async function fetchPlaceSuggestions(query, loc, signal) {
  const { provider, key } = loc || {};
  if (!query.trim()) return [];
  if (Platform.OS === 'ios') {
    return fetchAppleSuggestions(query, signal);
  }
  if (!key) return [];
  if (provider === 'amap') return fetchAmapSuggestions(query, key, signal);
  return fetchTdtSuggestions(query, key, signal);
}

async function fetchAppleSuggestions(query, signal) {
  if (signal?.aborted) return [];
  const raw = await withTimeout(searchApplePlacesAsync(query), 6000);
  if (signal?.aborted) return [];
  return (raw || [])
    .filter((it) => it && it.name)
    .map((it) => {
      const lat = Number(it.lat);
      const lng = Number(it.lng);
      const hasCoord = !it.isPrompt && Number.isFinite(lat) && Number.isFinite(lng);
      const w = hasCoord ? gcj02ToWgs84(lat, lng) : null;
      return {
        name: String(it.name),
        district: String(it.district || ''),
        lng: w ? w.lng : null,
        lat: w ? w.lat : null,
        isPrompt: !w,
      };
    })
    .slice(0, 8);
}

async function fetchAppleGeocode(name, signal) {
  if (signal?.aborted) return null;
  const ll = await withTimeout(geocodeApplePlaceAsync(name), 6000);
  if (signal?.aborted || !ll) return null;
  const w = gcj02ToWgs84(ll.lat, ll.lng);
  return { lng: w.lng, lat: w.lat };
}

async function fetchTdtSuggestions(query, tdtKey, signal) {
  const postStr = JSON.stringify({
    keyWord: query.trim(),
    level: 12,
    mapBound: '73.0,3.0,136.0,54.0',
    queryType: '1',
    start: 0,
    count: 8,
  });
  const res = await withTimeout(fetch(`https://api.tianditu.gov.cn/v2/search?postStr=${encodeURIComponent(postStr)}&type=query&tk=${encodeURIComponent(tdtKey)}`, { headers: TDT_HEADERS, signal }));
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { throw new Error(`HTTP ${res.status} ${body.slice(0, 50)}`); }
  if (!res.ok || data.code) throw new Error(data.message || `HTTP ${res.status}`);
  if (data.status && data.status.infocode != null && String(data.status.infocode) !== '1000') {
    throw new Error(data.status.cndesc || `infocode ${data.status.infocode}`);
  }
  const items = [];
  const poiList = Array.isArray(data.pois) ? data.pois : (data.pois && data.pois.poi) || [];
  poiList.forEach((p) => {
    if (p && p.name) {
      const ll = parseLonlat(p.lonlat);
      items.push({ name: p.name, district: [p.typeName, p.address].filter(Boolean).join(' · '), lng: ll ? ll.lng : null, lat: ll ? ll.lat : null, isPrompt: false });
    }
  });
  if (data.area && data.area.name) {
    const ll = parseLonlat(data.area.lonlat);
    items.push({ name: data.area.name, district: '行政区划', lng: ll ? ll.lng : null, lat: ll ? ll.lat : null, isPrompt: false });
  }
  (data.prompt || []).forEach((p) => {
    if (p && p.keyword) {
      const admins = (p.admins || []).map((a) => a.adminName).filter(Boolean).join('');
      items.push({ name: p.keyword, district: '联想词 · ' + (admins || '点击继续搜索'), lng: null, lat: null, isPrompt: true });
    }
  });
  (data.suggests || []).forEach((s) => {
    if (s && s.name) {
      const ll = parseLonlat(s.lonlat);
      items.push({ name: s.name, district: s.address || '', lng: ll ? ll.lng : null, lat: ll ? ll.lat : null, isPrompt: false });
    }
  });
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.name)) return false;
    seen.add(it.name);
    return true;
  }).slice(0, 8);
}

/* ---------------------- 高德（Android 检索，GCJ-02 转回 WGS-84） ---------------------- */
const amapLoc = (location) => {
  const [lng, lat] = String(location || '').split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
};

async function fetchAmapSuggestions(query, key, signal) {
  const url = `https://restapi.amap.com/v3/assistant/inputtips?key=${encodeURIComponent(key)}`
    + `&keywords=${encodeURIComponent(query.trim())}&datatype=all&city=全国&citylimit=false`;
  const res = await withTimeout(fetch(url, { signal }));
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { throw new Error(`HTTP ${res.status} ${body.slice(0, 50)}`); }
  if (data.status !== '1') throw new Error(data.info || `高德返回 ${data.infocode || res.status}`);
  return (data.tips || [])
    .filter((t) => t && t.name)
    .map((t) => {
      const ll = amapLoc(t.location);
      const w = ll ? gcj02ToWgs84(ll.lat, ll.lng) : null;
      return {
        name: t.name,
        district: [t.district, t.address].filter(Boolean).join(' · '),
        lng: w ? w.lng : null,
        lat: w ? w.lat : null,
        isPrompt: !w,
      };
    })
    .slice(0, 8);
}

async function fetchAmapGeocode(name, key, signal) {
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}`
    + `&address=${encodeURIComponent(name.trim())}`;
  const res = await withTimeout(fetch(url, { signal }));
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { return null; }
  if (data.status !== '1') return null;
  const first = (data.geocodes || [])[0];
  const ll = first && amapLoc(first.location);
  if (!ll) return null;
  const w = gcj02ToWgs84(ll.lat, ll.lng);
  return { lng: w.lng, lat: w.lat };
}

// 正地理编码：手输名称没走联想选择时的坐标兜底；解析不到返回 null
export async function fetchPlaceGeocode(name, loc, signal) {
  const { provider, key } = loc || {};
  if (!name.trim()) return null;
  if (Platform.OS === 'ios') {
    return fetchAppleGeocode(name, signal);
  }
  if (!key) return null;
  if (provider === 'amap') return fetchAmapGeocode(name, key, signal);
  return fetchTdtGeocode(name, key, signal);
}

async function fetchTdtGeocode(name, tdtKey, signal) {
  const res = await withTimeout(fetch(`https://api.tianditu.gov.cn/geocoder?postStr=${encodeURIComponent(JSON.stringify({ keyWord: name.trim() }))}&tk=${encodeURIComponent(tdtKey)}`, { headers: TDT_HEADERS, signal }));
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { return null; }
  if (!res.ok || data.code) return null;
  const loc = data.location || {};
  const lng = Number(loc.lon), lat = Number(loc.lat);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

/* ---------------------- 娱乐与阅读检索：豆瓣（影视/书籍）+ Steam（游戏） ---------------------- */
// 游戏源：Steam 商店搜索（免密钥、国区可直连、带竖版封面）
async function fetchSteamSuggestions(query, signal) {
  const res = await withTimeout(fetch(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=schinese&cc=CN`,
    { signal }
  ));
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).slice(0, 6).map((item) => ({
    title: item.name,
    meta: 'Steam',
    artwork: item.id
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id}/library_600x900.jpg`
      : null,
    ratio: DOUBAN_POSTER_RATIO,
  }));
}

// 返回 [{ title, meta, artwork, ratio }]；AbortError 原样抛出让调用方忽略
export async function fetchSuggestions(query, subType, signal) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  if (subType === 'game') return fetchSteamSuggestions(trimmed, signal);

  const host = doubanHostBySubType[subType];
  if (!host) return [];
  const res = await withTimeout(fetch(`https://${host}.douban.com/j/subject_suggest?q=${encodeURIComponent(trimmed)}`, {
    headers: DOUBAN_HEADERS,
    signal,
  }));
  if (!res.ok) return [];
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((item) => {
    if (host === 'book') {
      return {
        title: item.title,
        meta: [item.author_name, item.year].filter(Boolean).join(' · '),
        artwork: item.pic || null,
        ratio: null,
      };
    }
    return {
      title: item.title,
      meta: [
        item.sub_title && item.sub_title !== item.title ? item.sub_title : null,
        item.year,
      ].filter(Boolean).join(' · '),
      artwork: item.img ? item.img.replace('s_ratio_poster', 'l_ratio_poster') : null,
      ratio: DOUBAN_POSTER_RATIO,
    };
  }).filter((r) => r.title);
}
