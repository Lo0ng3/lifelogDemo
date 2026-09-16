// 列表 / 详情 / 日历页共用的类型图标配置。
// 图标沿用原来那套矢量图标（emoji 只留给随笔的心情），底色取一级类型配色。
import {
  Plane, Train, Bus, Ship, MapPin, Gamepad2, Book, Tv, Ghost, Film, NotebookPen, PenLine,
} from 'lucide-react-native';
import { groupColor, groupSoft } from './recordMeta';

export const getIconConfig = (item, colors) => {
  let IconComponent;
  if (item.baseType === 'ticket') {
    IconComponent = item.subType === 'flight' ? Plane : (item.subType === 'train' ? Train : (item.subType === 'bus' ? Bus : Ship));
  } else if (item.baseType === 'location') {
    IconComponent = MapPin;
  } else if (item.baseType === 'note') {
    IconComponent = item.subType === 'diary' ? NotebookPen : PenLine;
  } else {
    IconComponent = item.subType === 'game' ? Gamepad2 : (item.subType === 'book' ? Book : (item.subType === 'tv' ? Tv : (item.subType === 'anime' ? Ghost : Film)));
  }
  return {
    IconComponent,
    iconColor: groupColor(item, colors),
    iconBgColor: groupSoft(item, colors),
  };
};
