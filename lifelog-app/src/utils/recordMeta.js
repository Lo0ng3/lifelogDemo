// 记录的类型元数据：一级类型（旅票/地点/娱乐/随笔）、二级类型、emoji 图标、配色。
// 列表、月示图、详情页、筛选面板都从这里取，保证四处口径一致。

export const GROUP_LABEL = { ticket: '旅票', location: '地点', media: '娱乐', note: '随笔' };

export const SUB_LABEL = {
  flight: '机票', train: '火车票', bus: '汽车票', ship: '轮船',
  movie: '电影', tv: '剧集', anime: '动漫', game: '游戏', book: '书籍',
  diary: '日记', memo: '事迹',
};

// 类型图标一律用 emoji（不再用矢量图标组件）
export const TYPE_EMOJI = {
  flight: '✈️', train: '🚄', bus: '🚌', ship: '🚢',
  location: '📍',
  movie: '🎬', tv: '📺', anime: '👻', game: '🎮', book: '📖',
  diary: '📔', memo: '📝',
  ticket: '✈️', media: '🎬', note: '📔',
};

// 随笔（一级）的心情 emoji：预设 5 个 + 允许自填任意 emoji
export const MOOD_OPTIONS = ['😄', '🙂', '😌', '😤', '🥱'];
export const WEATHER_OPTIONS = ['晴', '多云', '阴', '雨', '雪'];

// 随笔的两个二级类型
export const NOTE_SUB_OPTIONS = [{ id: 'diary', label: '日记' }, { id: 'memo', label: '事迹' }];
export const TICKET_SUB_OPTIONS = [{ id: 'flight', label: '机票' }, { id: 'train', label: '火车票' }, { id: 'bus', label: '汽车票' }, { id: 'ship', label: '轮船' }];
export const MEDIA_SUB_OPTIONS = [{ id: 'movie', label: '电影' }, { id: 'tv', label: '剧集' }, { id: 'anime', label: '动漫' }, { id: 'game', label: '游戏' }, { id: 'book', label: '书籍' }];

export const isEssay = (item) => item?.baseType === 'note';
export const isDiary = (item) => item?.baseType === 'note' && item?.subType === 'diary';

export const emojiOf = (item) => TYPE_EMOJI[item?.subType] || TYPE_EMOJI[item?.baseType] || '📍';
export const labelOf = (item) => SUB_LABEL[item?.subType] || GROUP_LABEL[item?.baseType] || '记录';
export const groupLabelOf = (item) => GROUP_LABEL[item?.baseType] || '记录';

// 一级类型配色 / 浅底（颜色来自主题色板，深浅色各一套）
export const groupColor = (item, colors) => ({
  ticket: colors.groupTicket,
  location: colors.groupPlace,
  media: colors.groupMedia,
  note: colors.groupNote,
}[item?.baseType] || colors.groupPlace);

export const groupSoft = (item, colors) => ({
  ticket: colors.groupTicketSoft,
  location: colors.groupPlaceSoft,
  media: colors.groupMediaSoft,
  note: colors.groupNoteSoft,
}[item?.baseType] || colors.groupPlaceSoft);

// 列表 / 时间线里的星级（随笔用心情 emoji 顶替这一行）
export const starsOf = (rating) => {
  if (!rating) return null;
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.5;
  return { full, half };
};
