# 印记（lifelog-app）

记录旅票 / 地点 / 娱乐的印记 App，Expo + React Native（真机走 dev client，相册与地图依赖原生能力）。

## 结构速览

| 位置 | 作用 |
| --- | --- |
| `src/screens/*` | 四个页面：印记列表（含地图）、添加/编辑、详情、应用内选图器 |
| `src/theme/*` | 深浅色色板与主题 Provider（`useTheme` / `useThemedStyles`） |
| `src/utils/mapHtml.js` | 地图 WebView 的 HTML 生成器（纯函数，可离线跑预览） |
| `src/vendor/leafletBundle.js` | 由 `scripts/embed-leaflet.mjs` 生成，内联的 Leaflet（不走 CDN） |
| `vendor/leaflet/*` | Leaflet 原始产物（重生成上面那个 bundle 的输入） |
| `demo/*.html` | 浏览器里可以直接打开的设计/预览页 |

## 外观（深色模式）

- 默认 **跟随系统**：白天浅色、夜间深色；也可以在侧边栏「外观」里固定成浅色 / 深色（记在 `@theme_pref`）。
- 开屏图与页面底色一致（浅色 `#F2F2F7` / 深色 `#0F1115`），启动不会先闪一下再跳色。
- 页面配色统一走 `src/theme/palette.js`：改色板即可，页面里不再写死色值。
- `node scripts/preview-appearance.mjs` → `demo/appearance-preview.html`（浅/深并排 + 色板对照）。

## 地图

同一条 HTML 里有两套渲染引擎，交互、控件、标点聚合、内容卡分页、全屏都是共享的一套，只有「底图和图元怎么画」分引擎（`src/utils/mapHtml.js`）：

| 引擎 | 什么时候用 | 底图 | 深浅色 |
| --- | --- | --- | --- |
| **高德 JS API 2.0**（矢量 + WebGL） | 高德 + 填了「Web端(JS API) key」 | 官方矢量瓦片，缩放是 GPU 整体重绘，跟手 | 官方 `amap://styles/dark`，不用滤镜 |
| **Leaflet**（栅格瓦片） | 天地图；或高德但没填 JS API key | 天地图 vec/cva，或高德街道栅格图 | 深色对瓦片层做 CSS 反相滤镜 |

- Leaflet 已内联进 bundle（`node scripts/embed-leaflet.mjs` 重新生成），不再依赖 CDN；**矢量模式不注入 Leaflet**，省掉 145KB 内联脚本。
- **高德要用三把 key 各管一件事**（侧边栏「地图服务」里填）：「Web 服务」key 只给地点联想 / 地理编码（REST，RN 侧直接请求）；「Web端(JS API)」key + 安全密钥 securityJsCode 给地图渲染。后两个留空就自动用高德栅格瓦片（免 key）。
- **JS API 出不来图会自动切回栅格底图**并在顶部说明原因（key 无效时高德返回的脚本连 `AMap` 都不定义；SDK 也不一定 8 秒内出首帧），所以不会白屏。
- 坐标系统一存 WGS-84；用高德底图显示时自动转 GCJ-02，从高德检索拿到的坐标入库前转回 WGS-84，所以在两家之间切换不会让已有地点/轨迹偏移。
- 右下角两个小胶囊控制「轨迹 / 标点」，右上角缩放 + 全览 + 全屏；**单击标点**在标点上方弹出内容卡（标题/日期/类型/备注 + 查看详情），**连点两次**才飞到该点并适度放大（最多 12 级）。
- **同一个坐标上的多条记录只画一个标点**（坐标 4 位小数 ≈ 11 米内算同一个地点，旅票起点与地点记录落在一起也会合并），右上角数字角标写这个点上有几条；卡片底部「‹ 1/2 ›」左右切换记录（首尾循环），也可以直接左右滑卡片，「查看详情」跟着当前这条走。
- 右上角**全屏**：只让**地图本身**横过来铺满整屏——窗口始终是竖屏（`app.json` 的 `orientation: portrait`），全屏时把地图这块内容绕中心转 90°、宽高互换，所以列表/日历/添加/详情的排版完全不受影响，也没有系统转屏那一套回调。全屏不是换一个 WebView：地图层原地撑满（视角、已打开的卡片都保住）；再点一次或按系统返回键退出。手机转过来看就是横屏地图。
  两个容易踩的坑（都已处理）：① 地图层不能再塞在列表那块容器里靠"负偏移"往外撑，否则 Android 会按父容器把它裁掉——现在地图层直接挂在根容器下，平时由测量摆到列表那块的位置，全屏时就是整屏（bounds 覆盖整屏，触摸也才收得到）；② 旋转层的**布局框**比屏幕大，Android 的 `clipChildren` 按布局框裁会把它裁成一条横带，所以外面套了一层边长为 `max(屏宽,屏高)` 的正方形"舞台"，旋转前后的范围都装得下。
- 全屏里点「查看详情」直接跳转（不用先退全屏、不用等转屏），详情页本身就是竖屏；从详情返回时地图仍然是刚才的全屏状态。
- **栅格模式还做过的优化**：缩放动画期间不再每帧重算瓦片网格（`updateWhenZooming: false`）、`keepBuffer` 收到 3 少留屏外瓦片、**缩放刚开始和地图停稳后都预热下一级瓦片**（旧版预热被「没 key 就 return」挡住，高德用户等于一张都不预热）。真想要高德 App 那种顺滑，走上面的 JS API 引擎。
- 标点手势直接绑在标点元素上（pointer/touch），不依赖 WebView 的 click 合成；内容卡是自绘浮层（跟着地图移动），不走 Leaflet 弹窗，因此不会被地图的点击事件关掉。
- 地图层保活：首次进地图后常驻、只切透明度，列表/日历仍一次只挂一个；瓦片不会因为切视图而重载。
- 坐标缺失/异常的记录会被跳过，不会影响其它标点，也不会让缩放按钮失效（曾经就是脏坐标抛错把后面的绑定全带崩）。改完地图逻辑跑一下 `node scripts/check-map-script.mjs` 自检：脏坐标、合并标点/角标、卡片左右翻、全屏消息、栅格预热与缩放选项、**矢量模式的初始化（样式/坐标顺序/点击卡片）与失败回退**。
- `node scripts/preview-map.mjs [--key=天地图Key] [--provider=amap] [--jsapi-key=… --jsapi-code=…]` → `demo/map-preview-light.html` / `-dark.html`（`--provider=amap` 出高德栅格版，文件名带 `-amap`；带上 `--jsapi-key` 出矢量版 `-amap-jsapi`，浏览器里也能跑，方便对照两种引擎）。

## 选图器

应用内直读相册、只记录 `assetId`（零复制）。滚动性能的关键点：缩略图内存缓存 + 预取、
memo 化的格子、虚拟化窗口收敛到 ±2 屏、滚动/拖动动画全部跑在 UI 线程（Reanimated），
滚动过程中不再有 setState。

## 从系统分享进来（图库选图 → 分享到「印记」）

- 在系统图库/相册里选好照片或视频 → 分享 → 选「印记」，App 会被拉起（或从后台回到前台）
  并**直接落到「添加」页**，这些影像已经挂在表单的照片区，类型 / 日期 / 评论照常自己填。
- 原生入口：`expo-share-intent`（SDK 54 对应 v5）的 config plugin 在 `AndroidManifest` 里
  给 MainActivity 加了 `ACTION_SEND` 与 `ACTION_SEND_MULTIPLE` 的 `image/*` / `video/*`
  过滤条件，并把 launchMode 设为 `singleTask`（App 在前台时走 onNewIntent 而不是重开）。
  **这是原生改动：必须重新构建 APK，也不能用 Expo Go。** iOS 这版显式关掉了（`disableIOS: true`），
  要用的话得另配 share extension（该包在 iOS 上还需要一个 xcode patch）。
- 分享进来的文件会先被原生模块落到**系统缓存**，缓存随时可能被清、而且不在 App 自己的媒体目录里，
  所以 [ShareIntentBridge](src/components/ShareIntentBridge.js) 会**复制一份到 `documentDirectory/media/`**：
  这样就走上了和应用内选图完全相同的流水线——保存记录时按 文件名/大小/尺寸 重链回相册原片，
  重链成功即删掉副本（App 长期不持有副本）；重链不上也能当本地副本正常显示。
- 实现位置：`App.js` 最外层挂 `ShareIntentProvider`，`ShareIntentBridge` 收下文件 → 复制 →
  通过 `navigationRef` 跳到「Main / Add」并带上 `params.sharedMedia`，`AddScreen` 收到后追加到
  `selectedImages` 并清掉参数（`shareToken` 保证同一批影像重复分享也能再次触发）。

## 视图与类型

- 首页三段视图：**列表 / 月示 / 地图**。月示图上半是日历（圆点按一级类型着色，最多 3 个 + `+N`），
  下半是当月 / 当日时间线；点日期只看当天，点条目进详情，左右滑日历换月。
- 一级类型四个：**旅票 / 地点 / 娱乐 / 随笔**（随笔下面分 **日记 / 事迹**）。
  所有类型的列表行都会显示统一的类型标签；类型图标统一用 emoji。
- 随笔：标题选填、日期、心情（emoji，必填，预设 5 个 + 可自填）、内容、照片；
  日记多一个天气。随笔没有评分，也不打地图标点。
- 添加印记时，**同一天**已经记过同一个地点（坐标 200 米内或同名）、同一段行程（含同航班号/车次）、
  同一部作品时，表单里会出现一条可点的提示（也能直接跳去看已有的那条）；只是提醒，仍然可以继续保存。
- 列表与月示图的行是同一个组件（`src/components/RecordRow.js`），右滑都能改 / 删。

## 设计稿

- `node scripts/preview-calendar.mjs` → `demo/month-note-preview.html`：月示图（日历 + 当月时间线）与记事/日记（列表 + 新建流程）的交互设计稿。

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
