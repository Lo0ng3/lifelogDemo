// 地图 WebView 的 HTML 生成器（纯函数，可在 node 里直接跑出预览页）。
//
// 设计要点：
// 1) Leaflet 由 App 本地打包（assets/vendor）注入，不再依赖 CDN：国内网络下
//    jsdelivr/unpkg 经常拉不到，库加载失败时整张地图（连同标点）都会是空白；
// 2) 标点用内联 SVG 画，不依赖任何外部 CSS 类，避免个别 WebView 上
//    transform/border-radius 组合渲染异常导致「标点不见了」；
// 3) 控制条只保留两组小控件：右下角「轨迹 / 标点」两个小胶囊 + 右上角缩放，
//    尽量少遮挡地图；
// 4) 点标点 = 地图飞到该点并放大 + 弹出内容卡片（卡片里可跳详情）。

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

// 嵌入 script 的 JSON：转义 "<" 防止内容提前闭合标签
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

export function buildMapHtml({
  points = [],
  segs = [],
  tdtKey = '',
  colors,
  leafletJs = '',
  leafletCss = '',
} = {}) {
  const c = { ...DEFAULT_MAP_COLORS, ...(colors || {}) };
  const isDark = /invert/.test(c.tileFilter || '');
  const hasLeaflet = !!leafletJs;

  // 本地库缺失时的兜底：仍然给一组 CDN 地址，至少不是必然失败
  const cdnFallback = hasLeaflet ? '' : `
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        if (!window.L) document.write('<scr' + 'ipt src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"><\\/scr' + 'ipt>');
      </script>`;

  return `<!DOCTYPE html>
  <html>
  <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <style>${leafletCss}</style>
      ${cdnFallback}
      <style>
          html, body { height: 100%; width: 100%; margin: 0; padding: 0; background: ${c.bg};
              font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
          #map { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: ${c.bg}; }
          .leaflet-control-attribution { display: none; }
          .leaflet-container { background: ${c.bg}; outline: none; }
          ${c.tileFilter && c.tileFilter !== 'none'
            ? `.leaflet-tile-pane { filter: ${c.tileFilter}; }`
            : ''}
          .leaflet-popup-content-wrapper { background: ${c.cardBg}; color: ${c.cardText}; border-radius: 12px;
              box-shadow: 0 6px 22px rgba(0,0,0,${isDark ? '0.55' : '0.22'}); }
          .leaflet-popup-content { margin: 11px 13px; line-height: 1.45; }
          .leaflet-popup-tip { background: ${c.cardBg}; }
          .rc-title { font-size: 14px; font-weight: 700; color: ${c.cardText}; }
          .rc-meta { font-size: 11.5px; color: ${c.cardMeta}; margin-top: 2px; }
          .rc-note { font-size: 12.5px; color: ${c.cardNote}; margin-top: 5px; max-width: 210px;
              display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
          .rc-open { margin-top: 8px; font-size: 12.5px; font-weight: 600; color: ${c.controlText === '#374151' ? '#007AFF' : '#0A84FF'};
              background: none; border: none; padding: 0; font-family: inherit; }

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
          .toast { position: absolute; right: 10px; bottom: 48px; z-index: 900; padding: 5px 10px; border-radius: 9px;
              background: ${c.controlBg}; color: ${c.controlText}; font-size: 11.5px; border: 0.5px solid ${c.controlBorder};
              box-shadow: 0 3px 12px rgba(0,0,0,${isDark ? '0.45' : '0.18'}); opacity: 0; transition: opacity .18s; }
          .toast.show { opacity: 1; }

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

      ${hasLeaflet ? `<script>${leafletJs}</script>` : ''}
      <script>
          var POINTS = ${safeJson(points)};
          var SEGS = ${safeJson(segs)};
          var TK = ${safeJson(tdtKey || '')};
          var COLORS = ${safeJson(TYPE_COLORS)};
          var LOC_COLOR = ${safeJson(LOCATION_COLOR)};
          var DOT_BORDER = ${safeJson(c.dotBorder)};
          var MISSING_BG = ${safeJson(c.bg)};

          /* ------------------------------------------------------------------
           * 坐标兜底（1.6.6「放大缩小失效 + 没有标点」的根因就在这）
           *
           * Leaflet 的 LatLng 遇到 NaN/undefined 会直接抛 "Invalid LatLng object"。
           * 一旦某条记录的坐标缺失（例如只有 latitude、longitude 被 JSON 丢掉），
           * 抛错会把后面所有语句一起打断——于是瓦片还在（早就加好了），
           * 但标点画不出来，连缩放按钮的 onclick 都没绑上，表现就是"地图在、按钮点了没反应"。
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

          function safe(fn) { try { return fn(); } catch (e) { return null; } }

          function esc(s) {
              return String(s == null ? '' : s)
                  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
          }
          function $(id) { return document.getElementById(id); }
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
              var msg = JSON.stringify({ type: 'openDetail', id: id });
              if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
          };

          // 内容卡片里的「查看详情」用事件委托绑定，避免把 id 拼进 onclick 属性
          document.addEventListener('click', function (e) {
              var el = e.target && e.target.closest ? e.target.closest('.rc-open') : null;
              if (!el) return;
              e.preventDefault();
              e.stopPropagation();
              window.openDetail(el.getAttribute('data-detail'));
          });

          function boot() {
          if (!window.L) {
              // 库没起来时给明确提示，不留一块无法解释的空白
              if (!TK) showBanner('未配置天地图 Key，可在侧边栏「地图服务 Key」中填写');
              showHint('地图组件未能加载<br/><span style="font-size:11.5px">请检查网络后重新进入地图页</span>');
              return;
          }

          // closePopupOnClick: false —— 评论什么时候关由我们自己决定（默认行为会把
          // 标点刚弹出的评论立刻关掉，表现就是"单击标点没反应"）
          var map = L.map('map', { zoomControl: false, attributionControl: true, closePopupOnClick: false }).setView([34.0, 108.0], 4);
          map.attributionControl.setPrefix('');
          // 关掉 Leaflet 自带的双击放大：它会把"在标点上连点两次"吃掉，变成只放大一级，
          // 而我们要的是双击直接飞到该标点（缩放靠右下角/右上角控件就够了）
          if (map.doubleClickZoom) map.doubleClickZoom.disable();
          // 点地图空白处收起评论（标点的点击用 bubblingMouseEvents:false 拦住了，不会走到这里）
          map.on('click', function () { map.closePopup(); });
          if (TK) {
              L.tileLayer('https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk=' + TK, { subdomains: '01234567', maxZoom: 18 }).addTo(map);
              L.tileLayer('https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&x={x}&y={y}&l={z}&tk=' + TK, { subdomains: '01234567', maxZoom: 18 }).addTo(map);
          }

          var locLayer = L.layerGroup().addTo(map);
          var trajLayer = L.layerGroup().addTo(map);
          var trajOn = true, locOn = true;
          var allMarkers = [];

          // 标点：内联 SVG 画水滴型定位标，不依赖任何外部样式类
          function pinIcon(color) {
              var svg = '<svg width="22" height="28" viewBox="0 0 22 28" xmlns="http://www.w3.org/2000/svg">'
                  + '<path d="M11 26.4C11 26.4 19.4 17.2 19.4 10.6A8.4 8.4 0 1 0 2.6 10.6C2.6 17.2 11 26.4 11 26.4Z" fill="' + color + '" stroke="' + DOT_BORDER + '" stroke-width="1.8"/>'
                  + '<circle cx="11" cy="10.5" r="3.2" fill="' + DOT_BORDER + '"/></svg>';
              return L.divIcon({ className: 'rc-pin', html: svg, iconSize: [22, 28], iconAnchor: [11, 26], popupAnchor: [0, -22] });
          }
          function badgeIcon(count, color) {
              var html = '<div style="min-width:22px;height:22px;padding:0 4px;border-radius:11px;background:' + DOT_BORDER
                  + ';border:2px solid ' + color + ';color:' + color + ';font-size:11px;font-weight:700;'
                  + 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;">×' + count + '</div>';
              return L.divIcon({ className: 'rc-badge', html: html, iconSize: [22, 22], iconAnchor: [11, 11] });
          }

          function popupHtml(p) {
              return '<div class="rc-title">' + esc(p.title) + '</div>'
                  + '<div class="rc-meta">' + esc(p.date) + '</div>'
                  + (p.note ? '<div class="rc-note">' + esc(p.note) + '</div>' : '')
                  + '<button class="rc-open" data-detail="' + esc(String(p.id)) + '">查看详情 ›</button>';
          }

          // 点标点：飞到该点并放大（当前已经更近时保持原缩放），同时弹出内容卡片
          function focusPoint(p, marker) {
              var target = Math.max(map.getZoom(), p.zoom || 13);
              map.flyTo([p.lat, p.lng], target, { duration: 0.7, easeLinearity: 0.28 });
              setTimeout(function () { marker.openPopup(); }, 120);
          }

          /* ------------------------------------------------------------------
           * 标点手势：单击 = 显示/收起评论（不移动地图）；连点两次 = 放大飞到该标点。
           *
           * 这里不依赖 Leaflet 的 click：Android WebView 上 click 的合成时机和次数
           * 都不太一样（有的要等 ~300ms，有的还会多给一次），之前就出现过
           * "单击没反应、双击才冒评论"。现在直接绑在标点 DOM 元素上，用
           * pointerup / touchend / click 三种里最先到的那个来处理，并且拦在自己这里
           * 不让它冒泡到地图（地图默认会因为一次 click 把刚打开的评论关掉）。
           * ------------------------------------------------------------------ */
          var lastDomTapAt = 0;
          var DOUBLE_TAP_MS = 320;
          function bindTapGesture(p, marker) {
              var lastTapId = null, lastTapAt = 0;

              function handleTap() {
                  var now = Date.now();
                  lastDomTapAt = now;
                  if (lastTapId === p.id && (now - lastTapAt) < DOUBLE_TAP_MS) {
                      // 连点两次：收掉单击弹出来的评论，然后飞过去
                      lastTapId = null; lastTapAt = 0;
                      safe(function () { marker.closePopup(); });
                      focusPoint(p, marker);
                      return;
                  }
                  lastTapId = p.id; lastTapAt = now;
                  safe(function () {
                      if (marker.isPopupOpen()) marker.closePopup();
                      else marker.openPopup();
                  });
              }

              function consume(ev) {
                  if (ev) {
                      if (ev.stopPropagation) ev.stopPropagation();
                      if (ev.cancelable && ev.preventDefault) ev.preventDefault();
                  }
                  handleTap();
              }

              function bindElement() {
                  var el = marker.getElement && marker.getElement();
                  if (!el || el.__rcTapBound) return;
                  el.__rcTapBound = true;
                  var downAt = 0, downX = 0, downY = 0, lastEnd = 0;

                  function pointOf(ev) {
                      var t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
                      return { x: t.clientX || 0, y: t.clientY || 0 };
                  }
                  function onDown(ev) {
                      var pnt = pointOf(ev);
                      downAt = Date.now(); downX = pnt.x; downY = pnt.y;
                  }
                  function onEnd(ev) {
                      var now = Date.now();
                      if (now - lastEnd < 40) return;            // pointerup / touchend 同一拍只算一次
                      lastEnd = now;
                      var pnt = pointOf(ev);
                      var moved = Math.abs(pnt.x - downX) + Math.abs(pnt.y - downY);
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

              marker.on('add', bindElement);
              bindElement();
              // 兜底：万一拿不到 DOM 元素（很老的 WebView），仍走 Leaflet 的 click
              marker.on('click', function (e) {
                  if (e && e.originalEvent && L.DomEvent && L.DomEvent.stopPropagation) {
                      L.DomEvent.stopPropagation(e.originalEvent);
                  }
                  if (Date.now() - lastDomTapAt < 600) return;
                  handleTap();
              });
          }

          function makeMarker(p) {
              var color = p.kind === 'location' ? LOC_COLOR : (COLORS[p.subType] || '#2F7BF6');
              // 地点标点压在旅票标点之上：全览时同一个城市里两类点经常重叠，
              // 按默认的「纬度决定层级」会让红色地点点被蓝色的起终点盖住
              var marker = L.marker([p.lat, p.lng], {
                  icon: pinIcon(color),
                  riseOnHover: true,
                  // 关键：标点的点击不传给地图，否则地图会立刻把评论关掉（单击"没反应"的根因）
                  bubblingMouseEvents: false,
                  zIndexOffset: p.kind === 'location' ? 400 : 100,
              });
              // 单击只弹评论不移动地图，所以让弹窗自己轻微把地图挪进可视区（autoPan），
              // 双击的 flyTo 会覆盖这次平移
              marker.bindPopup(popupHtml(p), { closeButton: false, autoPan: true, autoPanPadding: [26, 62], offset: [0, -20], minWidth: 150, maxWidth: 230 });
              bindTapGesture(p, marker);
              marker.__point = p;
              allMarkers.push(marker);
              return marker;
          }
          function renderLoc() {
              locLayer.clearLayers();
              if (!locOn) return;
              POINTS.forEach(function (p) {
                  if (p.kind !== 'location') return;
                  // 单条数据出问题只丢这一个标点，不影响其它标点、轨迹和按钮
                  var m = safe(function () { return makeMarker(p); });
                  if (m) m.addTo(locLayer);
              });
          }
          function drawTraj() {
              trajLayer.clearLayers();
              if (!trajOn) return;
              POINTS.forEach(function (p) {
                  if (p.kind !== 'ticket') return;
                  var m = safe(function () { return makeMarker(p); });
                  if (m) m.addTo(trajLayer);
              });
              SEGS.forEach(function (seg) {
                  safe(function () { drawSeg(seg); });
              });
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
                  L.polyline(path, { color: color, weight: Math.min(9, 3 + (seg.count - 1) * 1.8), opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(trajLayer);
                  if (seg.count > 1) {
                      L.marker(path[14], { icon: badgeIcon(seg.count, color), interactive: false }).addTo(trajLayer);
                  }
          }
          function redraw() {
              try {
                  allMarkers = [];
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
              if (DROPPED > 0) msgs.push(DROPPED + ' 条记录的坐标不完整，已跳过（不影响其它标点）');
              if (!TK) msgs.push('未配置天地图 Key，可在侧边栏「地图服务 Key」中填写');
              if (msgs.length) showBanner(msgs.join(' · ')); else hideBanner();
          }

          // 用户自己拖过/缩放过之后，切回地图页不再强行拉回全览
          var programmatic = false;
          function fitAll() {
              var lls = [];
              if (locOn) POINTS.forEach(function (p) { if (p.kind === 'location') lls.push([p.lat, p.lng]); });
              if (trajOn) {
                  POINTS.forEach(function (p) { if (p.kind === 'ticket') lls.push([p.lat, p.lng]); });
                  SEGS.forEach(function (s) { lls.push([s.from.latitude, s.from.longitude], [s.to.latitude, s.to.longitude]); });
              }
              if (!lls.length) return;
              programmatic = true;
              map.fitBounds(lls, { padding: [34, 34], maxZoom: 12 });
              setTimeout(function () { programmatic = false; }, 600);
          }
          map.on('zoomend dragend', function () { if (!programmatic) map.__touched = true; });

          function setToggle(btn, on) {
              if (!btn) return;
              btn.className = 'tool ' + (on ? 'on' : 'off');
          }
          function on(id, fn) { var el = $(id); if (el) el.onclick = fn; }
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
          // 控件先绑定、再画数据：就算后面绘图出问题，缩放/开关也一定是活的
          on('zin', function () { map.zoomIn(); });
          on('zout', function () { map.zoomOut(); });
          on('zfit', function () { safe(fitAll); });

          redraw();
          if (POINTS.length || SEGS.length) setTimeout(function () { safe(fitAll); }, 350);
          window.onresize = function () { map.invalidateSize(); };
          window.__rcMap = {
              map: map,          // 预览页 / 调试用
              redraw: redraw,
              fit: fitAll,
              // 从列表切回地图：容器尺寸变了需要重新量；没被手动动过就再全览一次
              markDirty: function () {
                  var center = map.getCenter(), zoom = map.getZoom();
                  map.invalidateSize();
                  if (map.__touched) map.setView(center, zoom, { animate: false });
                  else fitAll();
              }
          };
          }
          boot();
      </script>
  </body>
  </html>`;
}
