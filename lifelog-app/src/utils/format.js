// 显示层的地名短名：把结尾的「国际机场 / 机场」去掉（"北京首都国际机场"→"北京首都"）。
// 仅用于列表标题、地图气泡、详情标题等展示处；存储数据保持原样，用户别名优先（别名存在 title 里会一起过这里）
export const shortPlaceName = (name) => {
  if (!name) return name;
  const short = String(name).replace(/(国际机场|机场)$/, '').trim();
  return short || name;
};

// 旅票标题展示："A → B" 两侧分别去后缀
export const shortTicketTitle = (title) => {
  if (!title) return title;
  return String(title).split(' → ').map(shortPlaceName).join(' → ');
};
