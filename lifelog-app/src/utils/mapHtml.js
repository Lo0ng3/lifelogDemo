// 地图 WebView 的 HTML 生成器（纯函数，可在 node 里直接跑出预览页）。
//
// 两种渲染引擎，同一套交互与控件（标点聚合、内容卡分页、全屏、开关都在共享核心里，
// 只有「怎么把底图/标点/线画出来」这一层按引擎实现）：
//
//   A. 高德 JS API 2.0（矢量瓦片 + WebGL，官方 SDK）——配了「Web端(JS API) key」时启用。
//      这是唯一能追上高德 App 那种缩放顺滑度的路子；深色也用官方深色样式，不再拿
//      CSS 滤镜反相瓦片。缺点：SDK 要联网从 webapi.amap.com 加载，key / 安全密钥
//      配错或网络不通就画不出来 —— 所以有自动回退（见 B）。
//   B. Leaflet + 栅格瓦片（天地图 / 高德街道图）——默认与回退路径，不需要高德 key。
//
// 其它设计要点：
// 1) Leaflet 由 App 本地打包（vendor/leaflet）内联注入，不依赖 CDN：国内网络下
//    jsdelivr/unpkg 经常拉不到，库加载失败时整张地图（连同标点）都会是空白；
// 2) 标点用内联 SVG 画，不依赖任何外部 CSS 类，避免个别 WebView 上
//    transform/border-radius 组合渲染异常导致「标点不见了」；
// 3) 控制条只保留两组小控件：右下角「轨迹 / 标点」两个小胶囊 + 右上角缩放/全览/全屏；
// 4) 点标点 = 地图飞到该点并放大 + 弹出内容卡片（卡片里可跳详情）；
// 5) 同一个坐标上的多条记录只画一个标点（角标显示条数），卡片里左右切换着看，
//    不再叠成一摞谁也点不准的针；
// 6) 「全屏」按钮通过 postMessage 交给 RN 侧铺满整屏 + 锁横屏（WebView 不重建，
//    所以视角和已打开的卡片都保住）；
// 7) 栅格模式下放大顺不顺，主要看「新一级的瓦片什么时候开始下」：缩放动画期间不重算
//    瓦片网格，并在地图停下来 / 刚开始缩放时就把下一级瓦片预热进 WebView 缓存。

const DEFAULT_MAP_COLORS = {
  bg: '#F2F2F7',
  controlBg: 'rgba(255,255,255,0.94)',
  controlText: '#374151',
  controlBorder: 'rgba(60,60,67,0.16)',
  cardBg: '#FFFFFF',
  cardText: '#1C1C1E',
  cardMeta: '#8E8E93',
  cardNote: '#374151',
  bannerBg: '#FFF7E6',
  bannerText: '#8A6D3B',
  dotBorder: '#FFFFFF',
  tileFilter: 'none',
};

const TYPE_COLORS = { flight: '#2F7BF6', train: '#10B981', bus: '#F97316', ship: '#8B5CF6' };
const LOCATION_COLOR = '#EE4D3D';
// 内容卡上显示的类型名（和 recordMeta.js 里的二级类型标签保持一致）
const TYPE_LABELS = { flight: '机票', train: '火车票', bus: '汽车票', ship: '轮船', location: '地点' };

// 底图（栅格模式）：天地图（WGS-84，需要 tk）/ 高德街道（GCJ-02，不需要 key）
const AMAP_TILE = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
// 矢量模式：高德官方 JS API 2.0
const AMAP_JS_BASE = 'https://webapi.amap.com/maps?v=2.0&key=';

// WGS-84 → GCJ-02：内部坐标统一 WGS-84，高德底图是火星坐标，不做纠偏会偏 300~600 米
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;
const gcjTransformLat = (x, y) => {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
};
const gcjTransformLng = (x, y) => {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
};
const wgs84ToGcj02 = (lat, lng) => {
  // 先转数字：坐标万一以字符串传进来，"lat + dLat" 会变成字符串拼接（结果是 NaN）
  lat = Number(lat); lng = Number(lng);
  if (!isFinite(lat) || !isFinite(lng)) return { lat, lng };
  if (!(lng > 72.004 && lng < 137.8347 && lat > 0.8293 && lat < 55.8271)) return { lat, lng };
  let dLat = gcjTransformLat(lng - 105.0, lat - 35.0);
  let dLng = gcjTransformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
};

// 嵌入 script 的 JSON：转义 "<" 防止内容提前闭合标签
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// 全屏按钮的两个图标（进入 = 四角向外，退出 = 四角向内）
const ICON_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>';
const ICON_COLLAPSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/></svg>';

export function buildMapHtml({
  points = [],
  segs = [],
  tdtKey = '',
  provider = 'tianditu',
  jsApiKey = '',
  securityCode = '',
  notice = '',
  dark,
  colors,
  leafletJs = '',
  leafletCss = '',
} = {}) {
  const c = { ...DEFAULT_MAP_COLORS, ...(colors || {}) };
  // 深色与否由调用方显式给（色板里没有这个字段）；没给就按 tileFilter 猜
  const isDark = typeof dark === 'boolean' ? dark : /invert/.test(c.tileFilter || '');
  const useAmap = provider === 'amap';
  // 配了「Web端(JS API) key」才走矢量渲染；没配就用栅格瓦片（免 key）
  const apiKey = String(jsApiKey || '').trim();
  const security = String(securityCode || '').trim();
  const useJsApi = useAmap && !!apiKey;
  const hasLeaflet = !useJsApi && !!leafletJs;
  // 高德两种模式都是 GCJ-02；天地图不用动
  const shift = useAmap ? (({ lat, lng }) => wgs84ToGcj02(lat, lng)) : ((p) => p);
  const shiftedPoints = points.map((p) => {
    const s = shift({ lat: p.lat, lng: p.lng });
    return { ...p, lat: s.lat, lng: s.lng };
  });
  const shiftedSegs = segs.map((seg) => {
    const from = shift({ lat: seg.from.latitude, lng: seg.from.longitude });
    const to = shift({ lat: seg.to.latitude, lng: seg.to.longitude });
    return {
      ...seg,
      from: { ...seg.from, latitude: from.lat, longitude: from.lng },
      to: { ...seg.to, latitude: to.lat, longitude: to.lng },
    };
  });

  // 栅格模式下 Leaflet 本地库缺失时的兜底：仍然给一组 CDN 地址，至少不是必然失败
  const cdnFallback = (!useJsApi && !leafletJs) ? `
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        if (!window.L) document.write('<scr' + 'ipt src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"><\\/scr' + 'ipt>');
      </script>` : '';

  return `<!DOCTYPE html>
  <html>
  <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      ${hasLeaflet ? `<style>${leafletCss}</style>` : ''}
      ${cdnFallback}
      <style>
          html, body { height: 100%; width: 100%; margin: 0; padding: 0; background: ${c.bg};
              font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
          #map { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: ${c.bg}; }
          .leaflet-control-attribution { display: none; }
          .leaflet-container { background: ${c.bg}; outline: none; }
          ${hasLeaflet && c.tileFilter && c.tileFilter !== 'none'
            ? `.leaflet-tile-pane { filter: ${c.tileFilter}; }`
            : ''}
          /* 高德 JS API 自带版权/Logo，按规范原样保留，不做隐藏 */
          .leaflet-popup-content-wrapper { background: ${c.cardBg}; color: ${c.cardText}; border-radius: 12px;
              box-shadow: 0 6px 22px rgba(0,0,0,${isDark ? '0.55' : '0.22'}); }
          .leaflet-popup-content { margin: 11px 13px; line-height: 1.45; }
          .leaflet-popup-tip { background: ${c.cardBg}; }

          /* ---- 控件：只占很小一块，尽量不挡地图 ---- */
          .zoomer { position: absolute; right: 10px; top: 10px; z-index: 800; display: flex; flex-direction: column;
              background: ${c.controlBg}; border: 0.5px solid ${c.controlBorder}; border-radius: 11px;
              box-shadow: 0 2px 10px rgba(0,0,0,${isDark ? '0.45' : '0.16'}); overflow: hidden; }
          /* 顶部提示条出现时把缩放控件让下去：原来两者都贴顶，提示条 z-index 更高，
             会压住缩放按钮，表现就是"点了没反应" */
          body.has-banner .zoomer { top: 36px; }
          .zoomer button { width: 32px; height: 30px; border: none; background: transparent; color: ${c.controlText};
              font-size: 15px; line-height: 1; cursor: pointer; font-family: inherit; }
          .zoomer button + button { border-top: 0.5px solid ${c.controlBorder}; }
          .zoomer button svg { width: 15px; height: 15px; display: block; margin: 0 auto; }
          .zoomer button:active { background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}; }

          .tools { position: absolute; right: 10px; bottom: 10px; z-index: 800; display: flex; gap: 6px; }
          .tool { display: flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px 0 8px;
              border-radius: 15px; border: 0.5px solid ${c.controlBorder}; background: ${c.controlBg};
              color: ${c.controlText}; font-size: 12px; font-family: inherit; font-weight: 500;
              box-shadow: 0 2px 10px rgba(0,0,0,${isDark ? '0.45' : '0.16'}); cursor: pointer;
              transition: background .15s, color .15s, opacity .15s; }
          .tool svg { width: 14px; height: 14px; display: block; }
          .tool.off { opacity: 0.5; }
          .tool.on { background: #0A84FF; border-color: #0A84FF; color: #FFF; }
          /* 提示挪到顶部居中：底部留给标点内容卡，避免两者叠在一起 */
          .toast { position: absolute; left: 50%; top: 40px; transform: translateX(-50%); z-index: 950; padding: 5px 10px; border-radius: 9px;
              background: ${c.controlBg}; color: ${c.controlText}; font-size: 11.5px; border: 0.5px solid ${c.controlBorder};
              box-shadow: 0 3px 12px rgba(0,0,0,${isDark ? '0.45' : '0.18'}); opacity: 0; transition: opacity .18s; }
          .toast.show { opacity: 1; }

          /* 标点内容卡：自绘浮层（不走引擎自带的弹窗，所以不会被地图的点击事件关掉），
             位置由 JS 跟着标点算，默认浮在标点上方，避免挡住标点本身影响连点两次 */
          .rcCard { position: absolute; left: 0; top: 0; z-index: 900; display: none; width: 224px;
              background: ${c.cardBg}; color: ${c.cardText}; border-radius: 13px; padding: 11px 13px;
              box-shadow: 0 8px 26px rgba(0,0,0,${isDark ? '0.55' : '0.24'}); will-change: transform; }
          .rcCard::after { content: ""; position: absolute; left: 50%; bottom: -6px; margin-left: -6px;
              width: 12px; height: 12px; border-radius: 2px; background: ${c.cardBg}; transform: rotate(45deg); }
          .rcCard.below::after { bottom: auto; top: -6px; }
          .rcCard .row { display: flex; align-items: flex-start; gap: 8px; }
          .rcCard .t { flex: 1; font-size: 14px; font-weight: 700; color: ${c.cardText}; }
          .rcCard .x { flex: none; width: 22px; height: 22px; border-radius: 11px; border: none; padding: 0;
              background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}; color: ${c.cardMeta};
              font-size: 13px; line-height: 1; font-family: inherit; }
          .rcCard .m { font-size: 11.5px; color: ${c.cardMeta}; margin-top: 3px; }
          .rcCard .n { font-size: 12.5px; color: ${c.cardNote}; margin-top: 6px; line-height: 1.5; max-height: 54px; overflow: hidden; }
          /* 底部一行：左边是同一条记录集里的左右切换（1/3），右边是查看详情 */
          .rcCard .ft { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
          .rcCard .pg { flex: none; width: 26px; height: 26px; border-radius: 13px; border: none; padding: 0;
              background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}; color: ${c.cardText};
              font-size: 15px; line-height: 1; font-family: inherit; }
          .rcCard .pg:active { background: ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)'}; }
          .rcCard .pi { flex: none; min-width: 30px; text-align: center; font-size: 11.5px; color: ${c.cardMeta};
              font-variant-numeric: tabular-nums; }
          .rcCard .go { margin-left: auto; font-size: 12.5px; font-weight: 600; color: ${c.controlText === '#374151' ? '#007AFF' : '#0A84FF'};
              background: none; border: none; padding: 0; font-family: inherit; }

          .hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 700;
              max-width: 78%; text-align: center; font-size: 12.5px; line-height: 1.7; color: ${c.cardMeta};
              background: ${c.controlBg}; border: 0.5px solid ${c.controlBorder}; border-radius: 12px; padding: 12px 16px; }
          .banner { position: absolute; top: 0; left: 0; right: 0; z-index: 950; background: ${c.bannerBg};
              color: ${c.bannerText}; font-size: 12px; line-height: 1.6; padding: 6px 10px; text-align: center; }
      </style>
  </head>
  <body>
      <div id="map"></div>
      <div class="banner" id="banner" style="display:none"></div>
      <div class="zoomer">
          <button id="zin" aria-label="放大">+</button>
          <button id="zout" aria-label="缩小">−</button>
          <button id="zfit" aria-label="全览">⤢</button>
          <button id="zfull" aria-label="全屏">${ICON_EXPAND}</button>
      </div>
      <div class="tools">
          <button id="tTraj" class="tool on" aria-label="出行轨迹">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="5" r="2.2"/><path d="M7 17.5C10.5 14.5 9 9.5 12.5 7.5"/></svg>
            <span>轨迹</span>
          </button>
          <button id="tLoc" class="tool on" aria-label="地点标点">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>
            <span>标点</span>
          </button>
      </div>
      <div class="toast" id="toast"></div>
      <div class="hint" id="hint" style="display:none"></div>
      <div class="rcCard" id="rcCard"></div>

      ${hasLeaflet ? `<script>${leafletJs}</script>` : ''}
      ${useJsApi ? `<script>
        // 安全密钥必须在 SDK 脚本之前设置（高德 2021-12 之后新建的 JS API key 都要配）
        window._AMapSecurityConfig = { securityJsCode: ${safeJson(security)} };
      </script>
      <script src="${AMAP_JS_BASE}${encodeURIComponent(apiKey)}"
        onerror="window.__rcAmapScriptError = '脚本加载失败'"></script>` : ''}
      <script>
          var POINTS = ${safeJson(shiftedPoints)};
          var SEGS = ${safeJson(shiftedSegs)};
          var TK = ${safeJson(tdtKey || '')};
          var PROVIDER = ${safeJson(provider)};
          var IS_JSAPI = ${useJsApi ? 'true' : 'false'};
          var USE_AMAP = PROVIDER === 'amap';
          var NEED_KEY = !USE_AMAP;                    // 只有天地图底图需要 key
          var COLORS = ${safeJson(TYPE_COLORS)};
          var LOC_COLOR = ${safeJson(LOCATION_COLOR)};
          var DOT_BORDER = ${safeJson(c.dotBorder)};
          var MISSING_BG = ${safeJson(c.bg)};
          var TYPE_LABELS = ${safeJson(TYPE_LABELS)};
          var EXPAND_ICON = ${safeJson(ICON_EXPAND)};
          var COLLAPSE_ICON = ${safeJson(ICON_COLLAPSE)};
          var NOTICE = ${safeJson(notice || '')};
          var DARK = ${isDark ? 'true' : 'false'};
          var fullscreen = false;
          // 用户动过地图（拖/缩）之后不再自动全览
          var mapTouched = false;

          /* ------------------------------------------------------------------
           * 坐标兜底（1.6.6「放大缩小失效 + 没有标点」的根因就在这）
           *
           * 引擎的 LatLng 遇到 NaN/undefined 会直接抛错（Leaflet 是
           * "Invalid LatLng object"），一旦某条记录的坐标缺失，抛错会把后面所有语句
           * 一起打断——于是瓦片还在，但标点画不出来，连缩放按钮的 onclick 都没绑上。
           * 所以：先把脏坐标滤掉，每个图层各自 try，控件绑定放在绘制之前。
           * ------------------------------------------------------------------ */
          function num(v) {
              if (v === null || v === undefined || v === '') return null;
              var n = typeof v === 'number' ? v : Number(v);
              return isFinite(n) ? n : null;
          }
          function cleanPoint(p) {
              var lat = num(p.lat), lng = num(p.lng);
              if (lat === null || lng === null) return null;
              if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
              return { id: p.id, kind: p.kind, subType: p.subType, title: p.title, date: p.date, note: p.note, lat: lat, lng: lng };
          }
          function cleanSeg(s) {
              var f = s && s.from, t = s && s.to;
              var from = { name: f && f.name, latitude: num(f && f.latitude), longitude: num(f && f.longitude) };
              var to = { name: t && t.name, latitude: num(t && t.latitude), longitude: num(t && t.longitude) };
              if (from.latitude === null || from.longitude === null || to.latitude === null || to.longitude === null) return null;
              return { from: from, to: to, count: s.count || 1, subType: s.subType };
          }
          var RAW = POINTS.length + SEGS.length;
          POINTS = POINTS.map(cleanPoint).filter(Boolean);
          SEGS = SEGS.map(cleanSeg).filter(Boolean);
          var DROPPED = RAW - (POINTS.length + SEGS.length);

          function safe(fn) { try { return fn(); } catch (e) { if (window.__rcDebug) console.log('rc-safe: ' + (e && e.message)); return null; } }
          function esc(s) {
              return String(s == null ? '' : s)
                  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
          }
          function $(id) { return document.getElementById(id); }
          function postMsg(msg) {
              try {
                  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
              } catch (e) {}
          }
          function showBanner(text) {
              var b = $('banner'); if (!b) return;
              b.textContent = text; b.style.display = 'block';
              document.body.className = 'has-banner';
          }
          function hideBanner() {
              var b = $('banner'); if (b) b.style.display = 'none';
              document.body.className = '';
          }
          function showHint(text) { var h = $('hint'); if (!h) return; h.innerHTML = text; h.style.display = 'block'; }
          function hideHint() { var h = $('hint'); if (h) h.style.display = 'none'; }
          var toastTimer = null;
          function toast(text) {
              var t = $('toast'); if (!t) return;
              t.textContent = text; t.className = 'toast show';
              clearTimeout(toastTimer);
              toastTimer = setTimeout(function () { t.className = 'toast'; }, 1100);
          }
          // 桥接：弹窗「查看详情」→ postMessage → 应用侧跳转详情页
          window.openDetail = function (id) {
              postMsg({ type: 'openDetail', id: id });
          };
          document.addEventListener('click', function (e) {
              var el = e.target && e.target.closest ? e.target.closest('.rc-open') : null;
              if (!el) return;
              e.preventDefault();
              e.stopPropagation();
              window.openDetail(el.getAttribute('data-detail'));
          });

          /* ---------------- 标点聚合 ----------------
             同一个地点往往有好几条记录（同一个机场飞过很多次、同一个地方去过很多回）。
             以前是一条记录一根针，针一模一样地叠在一起，点到的永远是最后一根，
             前面的记录等于看不见。现在按坐标合并：一个地点一根针，
             右上角角标写「这个点有几条记录」，点开后用卡片里的左右箭头翻。 */
          function groupKey(p) {
              // 4 位小数 ≈ 11 米：同一个地点因检索/录入产生的微小差异也算同一个点
              return p.lat.toFixed(4) + ',' + p.lng.toFixed(4);
          }
          function groupColor(records) {
              for (var i = 0; i < records.length; i++) {
                  if (records[i].kind === 'location') return LOC_COLOR;   // 有地点记录就按地点（红）画
              }
              return COLORS[records[0].subType] || '#2F7BF6';
          }
          function buildGroups() {
              var buckets = {}, groups = [];
              POINTS.forEach(function (p) {
                  var key = groupKey(p);
                  var g = buckets[key];
                  if (!g) {
                      g = { id: 'g' + (groups.length + 1), lat: p.lat, lng: p.lng, records: [] };
                      buckets[key] = g;
                      groups.push(g);
                  }
                  g.records.push(p);
              });
              groups.forEach(function (g) {
                  // 有地点记录的归「标点」层，纯旅票的归「轨迹」层（两层各有开关）
                  g.onLoc = g.records.some(function (r) { return r.kind === 'location'; });
                  g.color = groupColor(g.records);
              });
              return groups;
          }
          var GROUPS = [];

          // 标点：内联 SVG 画水滴型定位标，不依赖任何外部样式类。
          // 一个地点有多条记录时仍然只画一根针，但针上不再挂「×N」角标——
          // 有几条翻开内容卡看「1/2」就行，地图上保持干净。
          function pinIcon(color) {
              return '<svg width="22" height="28" viewBox="0 0 22 28" xmlns="http://www.w3.org/2000/svg">'
                  + '<path d="M11 26.4C11 26.4 19.4 17.2 19.4 10.6A8.4 8.4 0 1 0 2.6 10.6C2.6 17.2 11 26.4 11 26.4Z" fill="' + color + '" stroke="' + DOT_BORDER + '" stroke-width="1.8"/>'
                  + '<circle cx="11" cy="10.5" r="3.2" fill="' + DOT_BORDER + '"/></svg>';
          }
          function badgeIcon(count, color) {
              return '<div style="min-width:22px;height:22px;padding:0 4px;border-radius:11px;background:' + DOT_BORDER
                  + ';border:2px solid ' + color + ';color:' + color + ';font-size:11px;font-weight:700;'
                  + 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;">×' + count + '</div>';
          }

          /* ---------------- 标点手势 ----------------
             单击 = 显示/收起内容卡（不移动地图）；连点两次 = 放大飞到该标点。

             这里不依赖引擎的 click 合成：Android WebView 上 click 的时机和次数都不太一样
             （有的要等 ~300ms，有的还会多给一次），之前就出现过"单击没反应、双击才冒评论"。
             现在直接绑在标点 DOM 元素上，用 pointerup / touchend / click 里最先到的那个处理，
             并拦在自己这里不让它冒泡到地图（否则地图会立刻把刚打开的评论关掉）。
             引擎自己的 click 只当兜底，且用 TAP_GATE 去重。 */
          var TAP_GATE = { lastDomTapAt: 0 };
          function attachPinTap(el, onTap) {
              if (!el || !el.addEventListener || el.__rcTapBound) return;
              el.__rcTapBound = true;
              var downAt = 0, downX = 0, downY = 0, lastEnd = 0;
              function pointOf(ev) {
                  var t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
                  return { x: t.clientX || 0, y: t.clientY || 0 };
              }
              function consume(ev) {
                  if (ev) {
                      if (ev.stopPropagation) ev.stopPropagation();
                      if (ev.cancelable && ev.preventDefault) ev.preventDefault();
                  }
                  TAP_GATE.lastDomTapAt = Date.now();
                  onTap();
              }
              function onDown(ev) {
                  var p = pointOf(ev);
                  downAt = Date.now(); downX = p.x; downY = p.y;
              }
              function onEnd(ev) {
                  var now = Date.now();
                  if (now - lastEnd < 40) return;            // pointerup / touchend 同一拍只算一次
                  lastEnd = now;
                  var p = pointOf(ev);
                  var moved = Math.abs(p.x - downX) + Math.abs(p.y - downY);
                  // 长按或拖动过（多半是在拖地图）不算点击
                  if (moved > 14 || (downAt && now - downAt > 800)) return;
                  consume(ev);
              }
              el.addEventListener('pointerdown', onDown, true);
              el.addEventListener('touchstart', onDown, true);
              el.addEventListener('pointerup', onEnd, true);
              el.addEventListener('touchend', onEnd, true);
              el.addEventListener('click', function (ev) {
                  if (Date.now() - lastEnd < 600) return;    // 上面已经处理过这一下
                  consume(ev);
              }, true);
          }
          // 引擎 click 的兜底入口：DOM 那层刚处理过就跳过，避免一次点击算两下
          function fallbackTap(onTap) {
              return function () {
                  if (Date.now() - TAP_GATE.lastDomTapAt < 600) return;
                  onTap();
              };
          }
          var DOUBLE_TAP_MS = 320;
          function makeTapHandler(g) {
              var lastTapId = null, lastTapAt = 0;
              return function () {
                  var now = Date.now();
                  if (lastTapId === g.id && (now - lastTapAt) < DOUBLE_TAP_MS) {
                      // 连点两次：收掉单击弹出来的内容卡，然后飞过去
                      lastTapId = null; lastTapAt = 0;
                      hideCard();
                      focusPoint(g);
                      return;
                  }
                  lastTapId = g.id; lastTapAt = now;
                  // 单击：这个点没开卡片就弹出来（从最新一条记录开始），已经开着就收起。
                  // 不走引擎自带的弹窗，所以不会被地图的点击事件顺手关掉
                  safe(function () {
                      if (cardGroup && cardGroup.id === g.id) hideCard();
                      else showCard(g, 0);
                  });
              };
          }

          /* ---------------- 标点内容卡 ----------------
             一个标点上有多条记录时，卡片底部给「‹ 2/3 ›」左右切换（也可以左右滑卡片），
             标题 / 日期 / 类型 / 备注 / 查看详情 都跟着当前这一条走。 */
          var cardGroup = null;
          var cardIndex = 0;
          var cardLatLng = null;

          // 把内容卡摆到标点上方（贴近时自动翻到下方），并留出 34px 让标点本身露出来，
          // 这样连点两次仍然点在标点上，不会被卡片挡住
          function positionCard() {
              var card = $('rcCard');
              if (!card || !cardLatLng || card.style.display === 'none') return;
              var pt = Engine.toPoint(cardLatLng);
              var size = mapSize();
              var w = card.offsetWidth || 224;
              var h = card.offsetHeight || 90;
              var left = Math.round(pt.x - w / 2);
              left = Math.max(8, Math.min(size.x - w - 8, left));
              var below = false;
              var top = Math.round(pt.y - h - 30);
              if (top < 8) { top = Math.round(pt.y + 28); below = true; }
              card.className = 'rcCard' + (below ? ' below' : '');
              card.style.left = left + 'px';
              card.style.top = top + 'px';
          }
          var cardRaf = 0;
          function schedulePosition() {
              if (cardRaf) return;
              cardRaf = requestAnimationFrame(function () { cardRaf = 0; positionCard(); });
          }
          function mapSize() {
              var el = $('map');
              return el ? { x: el.clientWidth || 1, y: el.clientHeight || 1 } : { x: 1, y: 1 };
          }
          function typeLabel(p) {
              return TYPE_LABELS[p.kind === 'location' ? 'location' : p.subType] || '';
          }
          function renderCard() {
              var card = $('rcCard');
              if (!card || !cardGroup) return;
              var list = cardGroup.records;
              var n = list.length;
              if (cardIndex >= n) cardIndex = 0;
              var p = list[cardIndex];
              var meta = [p.date, typeLabel(p)].filter(Boolean).join(' · ');
              card.innerHTML =
                  '<div class="row"><span class="t">' + esc(p.title) + '</span>' +
                  '<button class="x" id="rcCardClose">✕</button></div>' +
                  '<div class="m">' + esc(meta) + '</div>' +
                  (p.note ? '<div class="n">' + esc(p.note) + '</div>' : '') +
                  '<div class="ft">' +
                  (n > 1
                      ? '<button class="pg" id="rcPrev" aria-label="上一条记录">‹</button>' +
                        '<span class="pi">' + (cardIndex + 1) + '/' + n + '</span>' +
                        '<button class="pg" id="rcNext" aria-label="下一条记录">›</button>'
                      : '') +
                  '<button class="go rc-open" data-detail="' + esc(String(p.id)) + '">查看详情 ›</button>' +
                  '</div>';
              var close = $('rcCardClose');
              if (close) close.onclick = function (ev) { if (ev) ev.stopPropagation(); hideCard(); };
              function bind(btnId, delta) {
                  var b = $(btnId);
                  if (b) b.onclick = function (ev) { if (ev) ev.stopPropagation(); stepCard(delta); };
              }
              bind('rcPrev', -1);
              bind('rcNext', 1);
          }
          function stepCard(delta) {
              if (!cardGroup) return;
              var n = cardGroup.records.length;
              if (n < 2) return;
              cardIndex = (cardIndex + delta + n) % n;   // 首尾循环，左右都能一直翻
              renderCard();
              positionCard();
              setTimeout(positionCard, 0);
          }
          function showCard(g, index) {
              var card = $('rcCard');
              if (!card || !g || !g.records.length) return;
              cardGroup = g;
              cardIndex = Math.max(0, Math.min(g.records.length - 1, index || 0));
              cardLatLng = { lat: g.lat, lng: g.lng };
              renderCard();
              card.style.display = 'block';
              positionCard();          // 先按标点位置摆好，再等布局稳定后校正一次
              setTimeout(positionCard, 0);
          }
          function hideCard() {
              cardGroup = null;
              cardIndex = 0;
              cardLatLng = null;
              var card = $('rcCard');
              if (card) card.style.display = 'none';
          }
          // 卡片上左右滑也能翻记录（和底部箭头等价）；没有明显横向位移的轻点不拦，
          // 按钮照常工作
          (function bindCardSwipe() {
              var card = $('rcCard');
              if (!card || !card.addEventListener) return;
              var sx = 0, sy = 0, tracking = false;
              function start(ev) {
                  var t = (ev.touches && ev.touches[0]) || ev;
                  sx = t.clientX || 0; sy = t.clientY || 0; tracking = true;
              }
              function end(ev) {
                  if (!tracking) return;
                  tracking = false;
                  var t = (ev.changedTouches && ev.changedTouches[0]) || ev;
                  var dx = (t.clientX || 0) - sx, dy = (t.clientY || 0) - sy;
                  if (Math.abs(dx) > 34 && Math.abs(dx) > Math.abs(dy) * 1.4) {
                      if (ev.stopPropagation) ev.stopPropagation();
                      stepCard(dx < 0 ? 1 : -1);
                  }
              }
              card.addEventListener('touchstart', start, true);
              card.addEventListener('touchend', end, true);
              card.addEventListener('pointerdown', start, true);
              card.addEventListener('pointerup', end, true);
          })();

          /* ==================================================================
           * 引擎适配层：上面那套核心逻辑只认这几个方法，
           * 下面分别用「高德 JS API 2.0」和「Leaflet」实现。
           * 坐标统一用 { lat, lng }，引擎内部自己转成各自的形式。
           * ================================================================== */
          var Engine = null;

          // 地图形变（平移/缩放中）→ 卡片跟着标点走；形变结束 → 记"用户动过地图"
          function createAmapEngine() {
              var map = new AMap.Map('map', {
                  center: [108, 34],
                  zoom: 4,
                  viewMode: '2D',
                  zooms: [3, 18],
                  resizeEnable: true,
                  // 双击放大保持开启：双击空白处放大一级，双击标点仍然是"飞到该标点"
                  // （标点的点击被自己的手势拦下了，不会和地图的双击冲突）
                  doubleClickZoom: true,
                  showLabel: true,
                  mapStyle: DARK ? 'amap://styles/dark' : 'amap://styles/normal',
                  features: ['bg', 'road', 'building', 'point'],
              });
              function group() {
                  var items = [];
                  return {
                      add: function (o) { items.push(o); safe(function () { map.add(o); }); return o; },
                      clear: function () { if (items.length) { safe(function () { map.remove(items); }); items = []; } },
                  };
              }
              return {
                  kind: 'amap',
                  group: group,
                  pin: function (ll, html, o) {
                      var wrap = document.createElement('div');
                      wrap.className = 'rc-pin';
                      wrap.style.cssText = 'width:22px;height:28px;';
                      wrap.innerHTML = html;
                      var m = new AMap.Marker({
                          position: [ll.lng, ll.lat],
                          content: wrap,
                          anchor: 'bottom-left',
                          // 水滴尖在 (11, 26)，相对 22×28 的左下角是往左 11、往下 2
                          offset: new AMap.Pixel(-11, 2),
                          zIndex: o && o.z ? o.z : 100,
                          bubble: false,
                      });
                      if (o && o.onTap) {
                          attachPinTap(wrap, o.onTap);
                          m.on('click', fallbackTap(o.onTap));
                      }
                      return m;
                  },
                  badge: function (ll, html) {
                      var el = document.createElement('div');
                      el.style.cssText = 'pointer-events:none;';
                      el.innerHTML = html;
                      var m = new AMap.Marker({
                          position: [ll.lng, ll.lat],
                          content: el,
                          anchor: 'center',
                          zIndex: 90,
                          clickable: false,
                          bubble: false,
                      });
                      return m;
                  },
                  polyline: function (path, o) {
                      return new AMap.Polyline({
                          path: path.map(function (p) { return [p[1], p[0]]; }),   // [[lat,lng]] → [[lng,lat]]
                          strokeColor: o.color,
                          strokeWeight: o.weight,
                          strokeOpacity: o.opacity,
                          lineCap: 'round',
                          lineJoin: 'round',
                          zIndex: 50,
                          bubble: false,
                      });
                  },
                  fitView: function (lls, pad, maxZoom) {
                      map.setFitView(null, false, [pad, pad, pad, pad], maxZoom);
                  },
                  flyTo: function (ll, zoom, duration) {
                      map.setZoomAndCenter(zoom, [ll.lng, ll.lat], false, Math.round(duration * 1000));
                  },
                  zoomIn: function () { map.zoomIn(); },
                  zoomOut: function () { map.zoomOut(); },
                  zoom: function () { return map.getZoom(); },
                  toPoint: function (ll) {
                      var p = map.lngLatToContainer(new AMap.LngLat(ll.lng, ll.lat));
                      return { x: p.getX(), y: p.getY() };
                  },
                  invalidateSize: function () {
                      // 2.0 开了 resizeEnable，容器变化一般自己会跟；这里再补一次强制重算
                      if (typeof map.resize === 'function') { map.resize(); return; }
                      safe(function () { map.setZoomAndCenter(map.getZoom(), map.getCenter(), true); });
                  },
                  onViewChange: function (fn) { map.on('mapmove', fn); map.on('zoomchange', fn); },
                  onViewStart: function (fn) { map.on('zoomstart', fn); },
                  onViewEnd: function (fn) { map.on('moveend', fn); map.on('zoomend', fn); },
                  onMapClick: function (fn) {
                      map.on('click', function () {
                          // 标点刚处理过点击时，地图这一次点击忽略掉（不同版本冒泡行为不一致）
                          if (Date.now() - TAP_GATE.lastDomTapAt < 600) return;
                          fn();
                      });
                  },
                  onReady: function (fn) { map.on('complete', fn); },
                  prefetch: function () {},   // 矢量瓦片由 SDK 自己管，不用预热
                  raw: function () { return map; },   // 预览页 / 调试用
              };
          }

          function createLeafletEngine() {
              // closePopupOnClick: false —— 评论什么时候关由我们自己决定（默认行为会把
              // 标点刚弹出的评论立刻关掉，表现就是"单击标点没反应"）
              var map = L.map('map', { zoomControl: false, attributionControl: true, closePopupOnClick: false }).setView([34.0, 108.0], 4);
              map.attributionControl.setPrefix('');
              // 双击放大保持开启（Leaflet 默认）：双击空白处放大一级；双击标点仍是"飞到该标点"——
              // 标点的手势把 DOM 事件拦在自己这一层了，地图容器收不到第二下，两者不会打架。

              // 手机端默认 updateWhenIdle=true：放大过程中不加载新瓦片，等动画结束才开始拉，
              // 看起来就是"放大很慢"。改成边放大边加载（false）。
              // updateWhenZooming: false —— 缩放动画期间不再每一帧重算瓦片网格（默认 true）：
              // 动画里用已有的瓦片缩放顶住，更跟手，也不会在每个中间帧发一堆无用请求。
              // keepBuffer 3：屏幕外少留一圈瓦片，DOM/合成层更轻。
              var tileOpts = { maxZoom: 18, updateWhenIdle: false, updateWhenZooming: false, keepBuffer: 3 };
              if (USE_AMAP) {
                  // 高德栅格街道图（矢量 + 注记一起出图），不需要 key
                  L.tileLayer(${safeJson(AMAP_TILE)}, Object.assign({ subdomains: '1234' }, tileOpts)).addTo(map);
              } else if (TK) {
                  L.tileLayer('https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk=' + TK, Object.assign({ subdomains: '01234567' }, tileOpts)).addTo(map);
                  L.tileLayer('https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&x={x}&y={y}&l={z}&tk=' + TK, Object.assign({ subdomains: '01234567' }, tileOpts)).addTo(map);
              }

              /* ---------------- 瓦片预热 ----------------
                 地图停稳后 / 刚开始缩放时，把下一级的瓦片先拉进 WebView 缓存，
                 真正放大时就大多命中缓存，不会一格一格慢慢冒出来。
                 注意：高德底图不需要 key，所以这里不能再看 TK，
                 否则高德用户等于一张都不预热（旧版就是这么被挡住的）。 */
              var prefetchKey = '';
              var prefetchTimer = null;
              function tileXY(lat, lng, z) {
                  var n = Math.pow(2, z);
                  var latRad = lat * Math.PI / 180;
                  return {
                      x: Math.floor((lng + 180) / 360 * n),
                      y: Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n),
                  };
              }
              function amapTileUrl(z, x, y) {
                  // 四个子域轮着来，避免单域名并发排队
                  return 'https://webrd0' + (1 + Math.abs(x + y) % 4) +
                      '.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=' + x + '&y=' + y + '&z=' + z;
              }
              function tdtTileUrl(z, x, y, lyr) {
                  var s = '01234567'.charAt(Math.abs(x + y) % 8);
                  return 'https://t' + s + '.tianditu.gov.cn/DataServer?T=' + lyr +
                      '&x=' + x + '&y=' + y + '&l=' + z + '&tk=' + TK;
              }
              // 逐张错开 40ms 下发：预热是"抢跑"，不能反过来把当前真正需要的那批瓦片挤在后面
              function grabTile(url, delay) {
                  setTimeout(function () {
                      safe(function () { var img = new Image(); img.decoding = 'async'; img.src = url; });
                  }, delay || 0);
              }
              function prefetchTiles() {
                  if (typeof Image === 'undefined') return;
                  if (!USE_AMAP && !TK) return;         // 天地图没 key 时连底图都没有，不用预热
                  var base = Math.round(map.getZoom());
                  var c = map.getCenter();
                  var t1 = tileXY(c.lat, c.lng, Math.min(18, base + 1));
                  var key = base + ':' + t1.x + ':' + t1.y;
                  if (key === prefetchKey) return;      // 同一格同一级已经预热过
                  prefetchKey = key;
                  var jobs = [];
                  [1, 2].forEach(function (dz) {
                      var z = base + dz;
                      if (z > 18) return;
                      var t = tileXY(c.lat, c.lng, z);
                      var r = dz === 1 ? 1 : 0;         // +1 级铺 3×3，+2 级只要中心那张
                      for (var dx = -r; dx <= r; dx++) {
                          for (var dy = -r; dy <= r; dy++) jobs.push([z, t.x + dx, t.y + dy]);
                      }
                  });
                  jobs.forEach(function (job, i) {
                      var z = job[0], x = job[1], y = job[2];
                      var max = Math.pow(2, z);
                      if (x < 0 || y < 0 || x >= max || y >= max) return;
                      var delay = i * 40;
                      if (USE_AMAP) grabTile(amapTileUrl(z, x, y), delay);
                      else {
                          grabTile(tdtTileUrl(z, x, y, 'vec_w'), delay);
                          grabTile(tdtTileUrl(z, x, y, 'cva_w'), delay);
                      }
                  });
              }

              return {
                  kind: 'leaflet',
                  group: function () {
                      var g = L.layerGroup().addTo(map);
                      return {
                          add: function (o) { g.addLayer(o); return o; },
                          clear: function () { g.clearLayers(); },
                      };
                  },
                  pin: function (ll, html, o) {
                      var m = L.marker([ll.lat, ll.lng], {
                          icon: L.divIcon({ className: 'rc-pin', html: html, iconSize: [22, 28], iconAnchor: [11, 26], popupAnchor: [0, -22] }),
                          riseOnHover: true,
                          // 关键：标点的点击不传给地图，否则地图会立刻把评论关掉
                          bubblingMouseEvents: false,
                          zIndexOffset: o && o.z ? o.z : 100,
                      });
                      if (o && o.onTap) {
                          var bind = function () { attachPinTap(m.getElement && m.getElement(), o.onTap); };
                          m.on('add', bind);
                          bind();
                          m.on('click', fallbackTap(o.onTap));
                      }
                      return m;
                  },
                  badge: function (ll, html) {
                      return L.marker([ll.lat, ll.lng], {
                          icon: L.divIcon({ className: 'rc-badge', html: html, iconSize: [22, 22], iconAnchor: [11, 11] }),
                          interactive: false,
                      });
                  },
                  polyline: function (path, o) {
                      return L.polyline(path, {
                          color: o.color, weight: o.weight, opacity: o.opacity,
                          lineCap: 'round', lineJoin: 'round',
                      });
                  },
                  fitView: function (lls, pad, maxZoom) {
                      map.fitBounds(lls.map(function (p) { return [p.lat, p.lng]; }), { padding: [pad, pad], maxZoom: maxZoom });
                  },
                  flyTo: function (ll, zoom, duration) {
                      map.flyTo([ll.lat, ll.lng], zoom, { duration: duration, easeLinearity: 0.28 });
                  },
                  zoomIn: function () { map.zoomIn(); },
                  zoomOut: function () { map.zoomOut(); },
                  zoom: function () { return map.getZoom(); },
                  toPoint: function (ll) { var p = map.latLngToContainerPoint([ll.lat, ll.lng]); return { x: p.x, y: p.y }; },
                  invalidateSize: function () { map.invalidateSize(); },
                  onViewChange: function (fn) { map.on('move zoom viewreset resize', fn); },
                  onViewStart: function (fn) { map.on('zoomstart', fn); },
                  onViewEnd: function (fn) { map.on('moveend zoomend', fn); },
                  onMapClick: function (fn) { map.on('click', fn); },
                  onReady: function (fn) { map.whenReady(fn); },
                  prefetch: prefetchTiles,
                  raw: function () { return map; },   // 预览页 / 调试用
              };
          }

          function createEngine() {
              return IS_JSAPI ? createAmapEngine() : createLeafletEngine();
          }

          // 双击标点：飞到该点并适度放大（原来直接跳到 13 级，观感太冲）
          function focusPoint(g) {
              var z = Engine.zoom();
              var target = z >= 12 ? z : Math.min(12, Math.max(z + 3, 9));
              Engine.flyTo({ lat: g.lat, lng: g.lng }, target, 0.55);
              setTimeout(function () { showCard(g, 0); }, 60);
          }

          function makeMarker(g) {
              // 地点标点压在旅票标点之上：全览时同一个城市里两类点经常重叠，
              // 按默认层级会让红色地点点被蓝色的起终点盖住。
              // 记录越多的点再往上一层，免得被邻居的单条记录挡住。
              var z = (g.onLoc ? 400 : 100) + Math.min(80, g.records.length * 4);
              return Engine.pin({ lat: g.lat, lng: g.lng }, pinIcon(g.color), { z: z, onTap: makeTapHandler(g) });
          }
          function renderLoc() {
              locLayer.clear();
              if (!locOn) return;
              GROUPS.forEach(function (g) {
                  if (!g.onLoc) return;
                  // 单条数据出问题只丢这一个标点，不影响其它标点、轨迹和按钮
                  safe(function () { locLayer.add(makeMarker(g)); });
              });
          }
          function drawTraj() {
              trajLayer.clear();
              if (!trajOn) return;
              GROUPS.forEach(function (g) {
                  if (g.onLoc) return;
                  safe(function () { trajLayer.add(makeMarker(g)); });
              });
              SEGS.forEach(function (seg) { safe(function () { drawSeg(seg); }); });
          }
          function drawSeg(seg) {
              var color = COLORS[seg.subType] || '#007AFF';
              var A = [seg.from.longitude, seg.from.latitude], B = [seg.to.longitude, seg.to.latitude];
              var dx = B[0] - A[0], dy = B[1] - A[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
              var bend = Math.min(1.6, Math.max(0.12, len * 0.14));
              var C = [(A[0] + B[0]) / 2 + dy / len * bend, (A[1] + B[1]) / 2 - dx / len * bend];
              var path = [];
              for (var i = 0; i <= 28; i++) {
                  var t = i / 28, u = 1 - t;
                  path.push([u * u * A[1] + 2 * u * t * C[1] + t * t * B[1], u * u * A[0] + 2 * u * t * C[0] + t * t * B[0]]);
              }
              trajLayer.add(Engine.polyline(path, {
                  color: color,
                  weight: Math.min(9, 3 + (seg.count - 1) * 1.8),
                  opacity: 0.85,
              }));
              if (seg.count > 1) {
                  trajLayer.add(Engine.badge({ lat: path[14][0], lng: path[14][1] }, badgeIcon(seg.count, color)));
              }
          }
          function redraw() {
              try {
                  hideCard();               // 重新绘制标点时把内容卡收掉，避免指向已经不存在的点
                  GROUPS = buildGroups();   // 按坐标把同一个地点的多条记录并成一个标点
                  renderLoc();
                  drawTraj();
              } catch (e) {
                  showHint('地图绘制出错：' + String(e && e.message || e));
              }
              syncHints();
          }
          function syncHints() {
              var any = POINTS.length > 0 || SEGS.length > 0;
              if (!any) {
                  showHint('当前筛选下没有可定位的印记<br/><span style="font-size:11.5px">在「地点」或「旅票」里选一个地名即可标点</span>');
              } else if ((!locOn && !trajOn)) {
                  showHint('标点与轨迹都已关闭');
              } else {
                  hideHint();
              }
              var msgs = [];
              if (NOTICE) msgs.push(NOTICE);
              if (DROPPED > 0) msgs.push(DROPPED + ' 条记录的坐标不完整，已跳过（不影响其它标点）');
              if (NEED_KEY && !TK) msgs.push('未配置天地图 Key，可在侧边栏「地图服务」中填写');
              if (msgs.length) showBanner(msgs.join(' · ')); else hideBanner();
          }

          // 用户自己拖过/缩放过之后，切回地图页不再强行拉回全览
          var programmatic = false;
          function fitAll() {
              var lls = [];
              if (locOn) GROUPS.forEach(function (g) { if (g.onLoc) lls.push({ lat: g.lat, lng: g.lng }); });
              if (trajOn) {
                  GROUPS.forEach(function (g) { if (!g.onLoc) lls.push({ lat: g.lat, lng: g.lng }); });
                  SEGS.forEach(function (s) {
                      lls.push({ lat: s.from.latitude, lng: s.from.longitude }, { lat: s.to.latitude, lng: s.to.longitude });
                  });
              }
              if (!lls.length) return;
              programmatic = true;
              Engine.fitView(lls, 34, 12);
              setTimeout(function () { programmatic = false; }, 600);
          }

          var locLayer = null, trajLayer = null;
          var trajOn = true, locOn = true;

          function setToggle(btn, on) {
              if (!btn) return;
              btn.className = 'tool ' + (on ? 'on' : 'off');
          }
          function on(id, fn) { var el = $(id); if (el) el.onclick = fn; }

          function boot() {
              // ① 引擎没起来：高德 JS API 交给 RN 切回栅格底图，天地图/栅格给明确提示
              if (IS_JSAPI && !window.AMap) {
                  postMsg({ type: 'jsApiFailed', reason: window.__rcAmapScriptError || '高德 JS API 未就绪（key / 安全密钥 / 网络）' });
                  showHint('高德 JS API 未能加载<br/><span style="font-size:11.5px">正在切回栅格底图…</span>');
                  return;
              }
              if (!IS_JSAPI && !window.L) {
                  if (NEED_KEY && !TK) showBanner('未配置天地图 Key，可在侧边栏「地图服务」中填写');
                  showHint('地图组件未能加载<br/><span style="font-size:11.5px">请检查网络后重新进入地图页</span>');
                  return;
              }

              Engine = safe(createEngine);
              if (!Engine) {
                  if (IS_JSAPI) {
                      postMsg({ type: 'jsApiFailed', reason: '高德地图初始化失败' });
                      showHint('高德地图初始化失败<br/><span style="font-size:11.5px">正在切回栅格底图…</span>');
                  } else {
                      showHint('地图初始化失败');
                  }
                  return;
              }

              locLayer = Engine.group();
              trajLayer = Engine.group();

              // 地图一动，卡片跟着标点走；点空白处收起卡片
              Engine.onViewChange(schedulePosition);
              Engine.onMapClick(function () { hideCard(); });
              Engine.onViewEnd(function () { if (!programmatic) mapTouched = true; });
              Engine.onViewStart(function () { safe(function () { Engine.prefetch(); }); });
              Engine.onViewEnd(function () { safe(function () { Engine.prefetch(); }); });

              // 控件先绑定、再画数据：就算后面绘图出问题，缩放/开关也一定是活的
              var btnTraj = $('tTraj'), btnLoc = $('tLoc');
              setToggle(btnTraj, trajOn);
              setToggle(btnLoc, locOn);
              on('tTraj', function () {
                  trajOn = !trajOn; setToggle(btnTraj, trajOn);
                  drawTraj(); syncHints(); toast('出行轨迹：' + (trajOn ? '开' : '关'));
              });
              on('tLoc', function () {
                  locOn = !locOn; setToggle(btnLoc, locOn);
                  renderLoc(); syncHints(); toast('地点标点：' + (locOn ? '开' : '关'));
              });
              on('zin', function () { Engine.zoomIn(); });
              on('zout', function () { Engine.zoomOut(); });
              on('zfit', function () { safe(fitAll); });
              // 全屏：铺满整屏 + 把地图转 90° 是 RN 侧做的（WebView 不重建，
              // 视角和已打开的卡片都保住），这里只负责发消息和按状态换图标
              on('zfull', function () {
                  // 本机先把状态翻过来：连点两次时第二次才不会被当成"再进一次全屏"
                  fullscreen = !fullscreen;
                  var b = $('zfull');
                  if (b) b.innerHTML = fullscreen ? COLLAPSE_ICON : EXPAND_ICON;
                  postMsg({ type: 'mapFullscreen', on: fullscreen });
              });

              redraw();
              if (POINTS.length || SEGS.length) setTimeout(function () { safe(fitAll); }, 350);
              window.onresize = function () { safe(function () { Engine.invalidateSize(); }); };

              // 矢量模式：SDK 加载成功 ≠ 地图画出来了（key 过期、安全密钥错、WebGL 不可用
              // 都可能停在"complete 一直不来"）。等不到首帧就交给 RN 切回栅格底图。
              if (IS_JSAPI) {
                  var ready = false;
                  Engine.onReady(function () { ready = true; });
                  setTimeout(function () {
                      if (!ready) postMsg({ type: 'jsApiFailed', reason: '高德地图长时间没有出图（key / 安全密钥 / WebGL）' });
                  }, 8000);
              }

              window.__rcMap = {
                  kind: Engine.kind,   // 'amap' | 'leaflet'：预览页 / 调试用
                  map: Engine.raw(),   // 原生地图对象：预览页挂 OSM 兜底底图要用
                  redraw: redraw,
                  fit: fitAll,
                  // RN 侧进了 / 退了全屏后回调：换按钮图标 + 按新尺寸重算
                  setFullscreen: function (on) {
                      fullscreen = !!on;
                      var b = $('zfull');
                      if (b) b.innerHTML = fullscreen ? COLLAPSE_ICON : EXPAND_ICON;
                      if (b) b.setAttribute('aria-label', fullscreen ? '退出全屏' : '全屏');
                      safe(function () { Engine.invalidateSize(); });
                      setTimeout(function () { safe(function () { Engine.invalidateSize(); }); }, 260);
                  },
                  // 从列表切回地图：地图层是保活的（尺寸没变），这里只做一次兜底重算，
                  // 不再重新全览——避免把用户上次的位置冲掉，也不会让瓦片白下载一轮
                  markDirty: function () {
                      safe(function () { Engine.invalidateSize(); });
                  },
              };
          }

          boot();
      </script>
  </body>
  </html>`;
}
