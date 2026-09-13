// src/data/mockData.js
// 旅票的出发/到达坐标存 start/end（天地图联想/地理编码写入），地点存 coordinates
export const initialLogData = [
  { 
    id: 1, baseType: 'ticket', subType: 'flight', title: '北京 → 上海', subtitle: 'MU5101', date: '2023-10-01', rating: null,
    start: { name: '北京首都国际机场', longitude: 116.5971, latitude: 40.0723 },
    end: { name: '上海虹桥国际机场', longitude: 121.3363, latitude: 31.1972 }
  },
  { 
    id: 2, baseType: 'location', subType: 'location', title: '外滩 & 南京东路', subtitle: '风很大，夜景绝美', date: '2023-10-02', rating: 4,
    localImages: ['https://images.unsplash.com/photo-1548248823-ce16a73c7347?auto=format&fit=crop&w=300&q=80'],
    coordinates: { latitude: 31.2304, longitude: 121.4737 } // 上海
  },
  { 
    id: 3, baseType: 'location', subType: 'location', title: 'Luneurs 咖啡馆', subtitle: '拿铁很棒', date: '2023-10-04', rating: 5,
    coordinates: { latitude: 31.2155, longitude: 121.4335 } 
  },
  { 
    id: 4, baseType: 'ticket', subType: 'train', title: '上海虹桥 → 北京南', subtitle: 'G1', date: '2023-10-07', rating: null,
    start: { name: '上海虹桥站', longitude: 121.3205, latitude: 31.1946 },
    end: { name: '北京南站', longitude: 116.3785, latitude: 39.8652 }
  },
  { 
    id: 10, baseType: 'ticket', subType: 'flight', title: '广州 → 曼谷', subtitle: 'CZ3081', date: '2025-03-15', rating: null,
    start: { name: '广州白云国际机场', longitude: 113.3024, latitude: 23.3924 },
    end: { name: '素万那普国际机场', longitude: 100.7470, latitude: 13.6900 }
  },
];