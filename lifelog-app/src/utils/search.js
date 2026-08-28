// 智能补全的检索源：豆瓣联想接口（国内直连、免密钥、带海报）
// - 电影/剧集/动漫 → 影视库，书籍 → 读书库
// - Apple 已把影视类目从 iTunes 搜索 API 下架，iTunes 音乐结果对记录作品没有参考价值，故不再兜底
// - 游戏没有稳定免密数据源，不提供联想（豆瓣主站联想接口已下线）

const DOUBAN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

const doubanHostBySubType = { movie: 'movie', tv: 'movie', anime: 'movie', book: 'book' };

export const supportsSearch = (subType) => !!doubanHostBySubType[subType];

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

// 返回 [{ title, meta, artwork }]；AbortError 原样抛出让调用方忽略
export async function fetchSuggestions(query, subType, signal) {
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
      };
    }
    return {
      title: item.title,
      meta: [
        item.sub_title && item.sub_title !== item.title ? item.sub_title : null,
        item.year,
      ].filter(Boolean).join(' · '),
      artwork: item.img ? item.img.replace('s_ratio_poster', 'l_ratio_poster') : null,
    };
  }).filter(r => r.title);
}
