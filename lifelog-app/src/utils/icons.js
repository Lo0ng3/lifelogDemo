// 首页列表和详情页共用的类型图标配置
import { Plane, Train, Bus, Ship, MapPin, Gamepad2, Book, Tv, Ghost, Film } from 'lucide-react-native';

export const getIconConfig = (item) => {
  let IconComponent, iconColor, iconBgColor;
  if (item.baseType === 'ticket') {
    IconComponent = item.subType === 'flight' ? Plane : (item.subType === 'train' ? Train : (item.subType === 'bus' ? Bus : Ship));
    iconColor = item.subType === 'flight' ? '#007AFF' : '#F97316';
    iconBgColor = item.subType === 'flight' ? '#E0F2FE' : '#FFEDD5';
  } else if (item.baseType === 'location') {
    IconComponent = MapPin;
    iconColor = '#EF4444';
    iconBgColor = '#FEE2E2';
  } else {
    IconComponent = item.subType === 'game' ? Gamepad2 : (item.subType === 'book' ? Book : (item.subType === 'tv' ? Tv : (item.subType === 'anime' ? Ghost : Film)));
    iconColor = '#A855F7';
    iconBgColor = '#F3E8FF';
  }
  return { IconComponent, iconColor, iconBgColor };
};
