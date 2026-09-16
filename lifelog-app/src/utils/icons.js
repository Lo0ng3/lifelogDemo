// 列表 / 详情 / 月示图共用的类型图标配置。
// 图标一律用 emoji（不再用矢量图标组件），底色仍是各类型的一级配色浅底。
import { emojiOf, groupColor, groupSoft } from './recordMeta';

export const getIconConfig = (item, colors) => ({
  emoji: emojiOf(item),
  iconColor: groupColor(item, colors),
  iconBgColor: groupSoft(item, colors),
});
