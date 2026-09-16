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

- Leaflet 已内联进 bundle（`node scripts/embed-leaflet.mjs` 重新生成），不再依赖 CDN；天地图 Key 在侧边栏「地图服务 Key」里填。
- 右下角两个小胶囊控制「轨迹 / 标点」，右上角缩放；点标点会飞到该点并放大、弹出内容卡片，卡片里可跳详情。
- 坐标缺失/异常的记录会被跳过，不会影响其它标点，也不会让缩放按钮失效（曾经就是脏坐标抛错把后面的绑定全带崩）。改完地图逻辑跑一下 `node scripts/check-map-script.mjs` 自检。
- `node scripts/preview-map.mjs [--key=天地图Key]` → `demo/map-preview-light.html` / `-dark.html`（不给 Key 时用 OSM 底图）。

## 选图器

应用内直读相册、只记录 `assetId`（零复制）。滚动性能的关键点：缩略图内存缓存 + 预取、
memo 化的格子、虚拟化窗口收敛到 ±2 屏、滚动/拖动动画全部跑在 UI 线程（Reanimated），
滚动过程中不再有 setState。

## 视图与类型

- 首页三段视图：**列表 / 月示 / 地图**。月示图上半是日历（圆点按一级类型着色，最多 3 个 + `+N`），
  下半是当月 / 当日时间线；点日期只看当天，点条目进详情，左右滑日历换月。
- 一级类型四个：**旅票 / 地点 / 娱乐 / 随笔**（随笔下面分 **日记 / 事迹**）。
  所有类型的列表行都会显示统一的类型标签；类型图标统一用 emoji。
- 随笔：标题选填、日期、心情（emoji，必填，预设 5 个 + 可自填）、内容、照片；
  日记多一个天气。随笔没有评分，也不打地图标点。
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
