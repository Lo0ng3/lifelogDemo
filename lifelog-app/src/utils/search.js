// 智能补全的检索源：豆瓣联想接口（国内直连、免密钥、带海报）
// - 电影/剧集/动漫 → 影视库，书籍 → 读书库
// - Apple 已把影视类目从 iTunes 搜索 API 下架，iTunes 音乐结果对记录作品没有参考价值，故不再兜底
// - 游戏没有稳定免密数据源，不提供联想（豆瓣主站联想接口已下线）

const DOUBAN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// 网络请求统一 8 秒超时：挂死的请求（豆瓣昨晚那种"不返回"）不再阻塞联想/封面回填流程。
// 超时只让调用方尽快失败，底层请求会随调用方的 AbortSignal 或 GC 结束
export const withTimeout = (promise, ms = 8000) => {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms));
  promise.catch(() => {}); // 超时先到时，落选方之后的拒绝不再触发未处理警告
  return Promise.race([promise, timeout]);
};

// 豆瓣海报是竖版 2:3（与 Steam library_600x900 一致）
const DOUBAN_POSTER_RATIO = 2 / 3;

const doubanHostBySubType = { movie: 'movie', tv: 'movie', anime: 'movie', book: 'book' };

// 地点联想 / 地理编码：天地图（lbs.tianditu.gov.cn，个人免费、全链路 WGS-84 无偏移）
// Key 在应用侧边栏「地图服务 Key」中配置（存本机 AsyncStorage），地图 WebView 底图共用
export const hasLocationSearch = (tdtKey) => !!tdtKey;

// 天地图 API 在华为云 WAF 后面：非浏览器 User-Agent（如 RN 的 okhttp）会被 403，统一伪装成浏览器
const TDT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

const parseLonlat = s => {
  if (!s) return null;
  const [lng, lat] = String(s).split(',').map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
};

// 地名搜索 V2.0 模糊搜索做输入联想。
// 返回 [{ name, district, lng, lat, isPrompt }]；isPrompt 的联想词无坐标，选中后拿 name 再搜一次
export async function fetchPlaceSuggestions(query, tdtKey, signal) {
  if (!tdtKey || !query.trim()) return [];
  const postStr = JSON.stringify({
    keyWord: query.trim(),
    level: 12,
    mapBound: '73.0,3.0,136.0,54.0',   // 全国范围
    queryType: '1',                     // 1 = 普通搜索
    start: 0, count: 8,
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
  // 普通 POI 结果（兼容 pois 为对象{poi:[]}或数组两种结构）
  const poiList = Array.isArray(data.pois) ? data.pois : (data.pois && data.pois.poi) || [];
  poiList.forEach(p => {
    if (p && p.name) {
      const ll = parseLonlat(p.lonlat);
      items.push({ name: p.name, district: [p.typeName, p.address].filter(Boolean).join(' · '), lng: ll ? ll.lng : null, lat: ll ? ll.lat : null, isPrompt: false });
    }
  });
  // 行政区划直接命中（如搜"北京"，带坐标）
  if (data.area && data.area.name) {
    const ll = parseLonlat(data.area.lonlat);
    items.push({ name: data.area.name, district: '行政区划', lng: ll ? ll.lng : null, lat: ll ? ll.lat : null, isPrompt: false });
  }
  // 联想词（无坐标）
  (data.prompt || []).forEach(p => {
    if (p && p.keyword) {
      const admins = (p.admins || []).map(a => a.adminName).filter(Boolean).join('');
      items.push({ name: p.keyword, district: '联想词 · ' + (admins || '点击继续搜索'), lng: null, lat: null, isPrompt: true });
    }
  });
  (data.suggests || []).forEach(s => {
    if (s && s.name) {
      const ll = parseLonlat(s.lonlat);
      items.push({ name: s.name, district: s.address || '', lng: ll ? ll.lng : null, lat: ll ? ll.lat : null, isPrompt: false });
    }
  });
  const seen = new Set();
  return items.filter(it => {
    if (seen.has(it.name)) return false;
    seen.add(it.name);
    return true;
  }).slice(0, 8);
}

// 正地理编码：手输名称没走联想选择时的坐标兜底；解析不到返回 null
export async function fetchPlaceGeocode(name, tdtKey, signal) {
  if (!tdtKey || !name.trim()) return null;
  const res = await withTimeout(fetch(`https://api.tianditu.gov.cn/geocoder?postStr=${encodeURIComponent(JSON.stringify({ keyWord: name.trim() }))}&tk=${encodeURIComponent(tdtKey)}`, { headers: TDT_HEADERS, signal }));
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { return null; }
  if (!res.ok || data.code) return null;
  const loc = data.location || {};
  const lng = Number(loc.lon), lat = Number(loc.lat);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

// 游戏源 1：Steam 商店搜索（免密钥、国区可直连、带封面）
// 竖版 library_600x900 封面对新老游戏普遍有效，和百科竖图一致适合当封面
async function fetchSteamSuggestions(query, signal) {
  const res = await withTimeout(fetch(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=schinese&cc=CN`,
    { signal }
  ));
  const data = await res.json();
  return (data.items || []).slice(0, 6).map(item => ({
    title: item.name,
    meta: 'Steam',
    artwork: item.id
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id}/library_600x900.jpg`
      : null,
    ratio: 2 / 3,
  }));
}

// 游戏源 2：百度百科开放接口（覆盖未上架 Steam 的主机/手机游戏等）
// 返回词条摘要 + 配图（bkimg CDN 无防盗链）+ 图片宽高
async function fetchBaikeSuggestion(query, signal) {
  const res = await withTimeout(fetch(
    `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(query)}&bk_length=600`,
    { signal }
  ));
  const data = await res.json();
  if (!data.title) return [];
  // 百科会返回最接近的词条，标题和搜索词完全无关的结果过滤掉
  const q = query.trim().toLowerCase();
  const t = String(data.title).toLowerCase();
  if (!t.includes(q) && !q.includes(t)) return [];
  const ratio = data.imageWidth && data.imageHeight ? data.imageWidth / data.imageHeight : null;
  return [{
    title: data.title,
    meta: data.desc || '百度百科词条',
    artwork: data.image || null,
    ratio,
  }];
}

async function fetchGameSuggestions(query, signal) {
  const results = await Promise.allSettled([
    fetchSteamSuggestions(query, signal),
    fetchBaikeSuggestion(query, signal),
  ]);
  const merged = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set();
  return merged.filter(({ title }) => {
    const key = title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 返回 [{ title, meta, artwork, ratio }]；AbortError 原样抛出让调用方忽略
export async function fetchSuggestions(query, subType, signal) {
  if (subType === 'game') return fetchGameSuggestions(query, signal);

  const host = doubanHostBySubType[subType];
  if (!host) return [];
  const res = await withTimeout(fetch(`https://${host}.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
    headers: DOUBAN_HEADERS,
    signal,
  }));
  if (!res.ok) return [];
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(item => {
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
  }).filter(r => r.title);
}
