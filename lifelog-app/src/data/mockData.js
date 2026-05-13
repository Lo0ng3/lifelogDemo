// src/data/mockData.js
export const initialLogData = [
  { 
    id: 1, baseType: 'ticket', subType: 'flight', title: '北京 → 上海', subtitle: 'MU5101', date: '2023-10-01', rating: null,
    coordinates: { latitude: 39.9042, longitude: 116.4074 } // 北京
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
    coordinates: { latitude: 39.8652, longitude: 116.3785 } 
  },
  { 
    id: 10, baseType: 'ticket', subType: 'flight', title: '广州 → 曼谷', subtitle: 'CZ3081', date: '2025-03-15', rating: null,
    coordinates: { latitude: 23.1291, longitude: 113.2644 } 
  },
];