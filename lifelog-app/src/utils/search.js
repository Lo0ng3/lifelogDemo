// 智能补全的检索源：豆瓣联想接口（国内直连、免密钥、带海报）
// - 电影/剧集/动漫 → 影视库，书籍 → 读书库
// - Apple 已把影视类目从 iTunes 搜索 API 下架，iTunes 音乐结果对记录作品没有参考价值，故不再兜底
// - 游戏没有稳定免密数据源，不提供联想（豆瓣主站联想接口已下线）

const DOUBAN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// 豆瓣海报是竖版 2:3（与 Steam library_600x900 一致）
const DOUBAN_POSTER_RATIO = 2 / 3;

const doubanHostBySubType = { movie: 'movie', tv: 'movie', anime: 'movie', book: 'book' };

export const supportsSearch = (subType) => subType === 'game' || !!doubanHostBySubType[subType];

// 地点联想（高德"输入提示"）：OSM/Nominatim 等免密钥服务在大陆网络不可直连，
// 需要在 lbs.amap.com 免费注册 → 创建应用 → Key（服务平台选"Web服务"），把 Key 填到下面即可启用
const AMAP_KEY = '';

export const hasLocationSearch = () => !!AMAP_KEY;

// 返回 [{ title, meta, location: "lng,lat" | null }]
export async function fetchLocationSuggestions(query, signal) {
  if (!AMAP_KEY || !query.trim()) return [];
  const res = await fetch(
    `https://restapi.amap.com/v3/assistant/inputtips?keywords=${encodeURIComponent(query)}&key=${AMAP_KEY}&datatype=poi`,
    { signal }
  );
  const data = await res.json();
  if (data.status !== '1') return [];
  return (data.tips || [])
    .filter(t => t.name)
    .map(t => ({
      title: t.name,
      meta: [t.district, t.address].filter(Boolean).join(' · '),
      location: t.location || null,
    }));
}

// 游戏源 1：Steam 商店搜索（免密钥、国区可直连、带封面）
// 竖版 library_600x900 封面对新老游戏普遍有效，和百科竖图一致适合当封面
async function fetchSteamSuggestions(query, signal) {
  const res = await fetch(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=schinese&cc=CN`,
    { signal }
  );
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
  const res = await fetch(
    `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(query)}&bk_length=600`,
    { signal }
  );
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
  const res = await fetch(`https://${host}.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
    headers: DOUBAN_HEADERS,
    signal,
  });
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
