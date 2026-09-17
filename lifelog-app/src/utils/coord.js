// 坐标系纠偏：内部统一存 WGS-84（GPS/EXIF/天地图都是这套），
// 只有用高德底图时才把显示坐标转成 GCJ-02（火星坐标），否则会偏 300~600 米。
// 反过来，从高德检索/地理编码拿到的坐标是 GCJ-02，入库前要转回 WGS-84。

const A = 6378245.0;
const EE = 0.00669342162296594323;

const transformLat = (x, y) => {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
};

const transformLng = (x, y) => {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
};

// 国外坐标不做偏移（GCJ-02 只在中国大陆有效）
const outOfChina = (lat, lng) => !(lng > 72.004 && lng < 137.8347 && lat > 0.8293 && lat < 55.8271);

export const wgs84ToGcj02 = (lat, lng) => {
  if (lat == null || lng == null || outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
};

// 反解用一次迭代近似即可（误差 < 2 米，对记录场景足够）
export const gcj02ToWgs84 = (lat, lng) => {
  if (lat == null || lng == null || outOfChina(lat, lng)) return { lat, lng };
  const g = wgs84ToGcj02(lat, lng);
  return { lat: lat * 2 - g.lat, lng: lng * 2 - g.lng };
};

// 按服务商决定要不要纠偏：天地图/OSM 是 WGS-84，高德/腾讯是 GCJ-02
export const toDisplayCoord = (provider, lat, lng) => (
  provider === 'amap' ? wgs84ToGcj02(lat, lng) : { lat, lng }
);

export const fromProviderCoord = (provider, lat, lng) => (
  provider === 'amap' ? gcj02ToWgs84(lat, lng) : { lat, lng }
);
