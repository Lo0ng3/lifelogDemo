# 印记（lifelog-app）

记录旅票 / 地点 / 娱乐的印记 App，Expo + React Native（真机走 dev client，相册与地图依赖原生能力）。

## 结构速览

| 位置 | 作用 |
| --- | --- |
| `src/screens/*` | 五个页面：印记列表（含地图）、添加/编辑、详情、应用内选图器、系统分享的落点（新建 / 追加到已有记录） |
| `src/components/HelpModal.js` | 侧边栏「说明」：页面上不放说明性文字，全部收在这里 |
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
- **打开「轨迹」会在它上面再弹一排「飞机 / 火车 / 汽车 / 轮船」小胶囊**：多选，关掉哪一类就不画那一类的轨迹弧线和起终点，任意组合；关掉「轨迹」时这排收起，重新打开后选择还在。这几个胶囊和「轨迹 / 标点」一样是**跑道型**，命中区按跑道形状判——点圆角外侧那块不算点到按钮（以前 DOM 的矩形命中区会让相邻按钮的"角"互相抢点击）。
- **一个地点只画一根针**：坐标 4 位小数（≈11 米）内的记录合并；**地名相同但坐标有差异的也合并**（检索结果和照片 GPS 抖出来的两个点、同一个地方手输过两次），**地点印记和旅票的出发地/目的地一起算**，落点取**记录最多的那一簇**，免得同一座机场并排插两根针、点哪根都只看得到一半记录。同名落点由 [mapPlaces](src/utils/mapPlaces.js) 统一算（去掉「机场」后缀、空白归一、老数据的「未命名记录」占位不算名字），**标点和轨迹弧线都用同一个落点**，线才会正好连到针上；用全量记录算，切筛选时位置不跳。卡片底部「‹ 1/2 ›」左右切换这个点上的全部记录（首尾循环），也可以直接左右滑卡片，「查看详情」跟着当前这条走。
- 右上角**全屏**：只让**地图本身**横过来铺满整屏——窗口始终是竖屏（`app.json` 的 `orientation: portrait`），全屏时把地图这块内容绕中心转 90°、宽高互换，所以列表/日历/添加/详情的排版完全不受影响，也没有系统转屏那一套回调。全屏不是换一个 WebView：地图层原地撑满（视角、已打开的卡片都保住）；再点一次或按系统返回键退出。手机转过来看就是横屏地图。
  两个容易踩的坑（都已处理）：① 地图层不能再塞在列表那块容器里靠"负偏移"往外撑，否则 Android 会按父容器把它裁掉——现在地图层直接挂在根容器下，平时由测量摆到列表那块的位置，全屏时就是整屏（bounds 覆盖整屏，触摸也才收得到）；② 旋转层的**布局框**比屏幕大，Android 的 `clipChildren` 按布局框裁会把它裁成一条横带，所以外面套了一层边长为 `max(屏宽,屏高)` 的正方形"舞台"，旋转前后的范围都装得下。
- 全屏里点「查看详情」直接跳转（不用先退全屏、不用等转屏），详情页本身就是竖屏；从详情返回时地图仍然是刚才的全屏状态。
- **栅格模式还做过的优化**：缩放动画期间不再每帧重算瓦片网格（`updateWhenZooming: false`）、`keepBuffer` 收到 3 少留屏外瓦片、**缩放刚开始和地图停稳后都预热下一级瓦片**（旧版预热被「没 key 就 return」挡住，高德用户等于一张都不预热）。真想要高德 App 那种顺滑，走上面的 JS API 引擎。
- 标点手势直接绑在标点元素上（pointer/touch），不依赖 WebView 的 click 合成；内容卡是自绘浮层（跟着地图移动），不走 Leaflet 弹窗，因此不会被地图的点击事件关掉。
- 地图层保活：首次进地图后常驻、只切透明度，列表/日历仍一次只挂一个；瓦片不会因为切视图而重载。
- 坐标缺失/异常的记录会被跳过，不会影响其它标点，也不会让缩放按钮失效（曾经就是脏坐标抛错把后面的绑定全带崩）。改完地图逻辑跑一下 `node scripts/check-map-script.mjs` 自检：脏坐标、**同名落点（地点印记 + 旅票起终点，含落点表与"弧线压在针上"的端到端检查）**、合并标点（同坐标 + 同名）、出行方式筛选、胶囊命中区、卡片左右翻、全屏消息、栅格预热与缩放选项、**矢量模式的初始化（样式/坐标顺序/点击卡片）与失败回退**。
- `node scripts/preview-map.mjs [--key=天地图Key] [--provider=amap] [--jsapi-key=… --jsapi-code=…]` → `demo/map-preview-light.html` / `-dark.html`（`--provider=amap` 出高德栅格版，文件名带 `-amap`；带上 `--jsapi-key` 出矢量版 `-amap-jsapi`，浏览器里也能跑，方便对照两种引擎）。

## 选图器

应用内直读相册、只记录 `assetId`（零复制）。滚动性能的关键点：缩略图内存缓存 + 预取、
memo 化的格子、虚拟化窗口收敛到 ±2 屏、滚动/拖动动画全部跑在 UI 线程（Reanimated），
滚动过程中不再有 setState。

## 从系统分享进来（图库选图 → 分享到「印记」）

- 在系统图库/相册里选好照片或视频 → 分享 → 选「印记」，App 会被拉起（或从后台回到前台）
  并弹出**「分享到印记」**（[ShareTargetScreen](src/screens/ShareTargetScreen.js)），两种去处：
  **新建印记**（落到「添加」页，影像已经挂在表单的照片区，类型 / 日期 / 评论照常自己填）；
  **添加到已有记录**（在记录列表里搜 / 挑一条，这些影像追加到它的「相关影像」末尾，
  追加走的是和保存记录同一条流水线：**先重链回相册原片**、副本重链成功即删；
  追加前会做一次去重，同一张已经在这条记录 / 别的记录里的会跳过并如实报数）。
- 原生入口：`expo-share-intent`（SDK 54 对应 v5）的 config plugin 在 `AndroidManifest` 里
  给 MainActivity 加了 `ACTION_SEND` 与 `ACTION_SEND_MULTIPLE` 的 `image/*` / `video/*`
  过滤条件，并把 launchMode 设为 `singleTask`（App 在前台时走 onNewIntent 而不是重开）。
  **这是原生改动：必须重新构建 APK，也不能用 Expo Go。** iOS 这版显式关掉了（`disableIOS: true`），
  要用的话得另配 share extension（该包在 iOS 上还需要一个 xcode patch）。
- 分享进来的文件会先被原生模块落到**系统缓存**，缓存随时可能被清、而且不在 App 自己的媒体目录里，
  所以 [ShareIntentBridge](src/components/ShareIntentBridge.js) 会**复制一份到 `MEDIA_DIR`**
  （见下面的「数据落点」）：
  这样就走上了和应用内选图完全相同的流水线——保存记录时按 文件名/大小/尺寸 重链回相册原片，
  重链成功即删掉副本（App 长期不持有副本）；重链不上也能当本地副本正常显示。
  复制完**立刻把缓存里那份删掉**（它只服务于这一次分享，留着白占空间）；
  在「分享到印记」里点取消，`media/` 里的副本也一并删掉。
- **数据落点**（[storagePaths](src/utils/storagePaths.js)）：`media`（分享副本）和 `covers`（封面小图）
  写在应用专属外部目录 `/storage/emulated/0/Android/data/<包名>/files/` 下，手机文件管理器能直接翻到、
  手动拷走；原生模块 [Paths](modules/paths) 拿不到该目录时（未挂载 / iOS）自动回退内部存储的
  `documentDirectory`，行为不变。`videoThumbs`（视频封面帧）与 `motionVideos`（实况提取的视频）
  是纯缓存，留在内部目录。这几个目录都随卸载删除，抗卸载只有系统相册和用户自选的公共目录。
- 侧边栏「清理缓存」现在一并调用 WebView 的 `clearCache(true)`，把栅格瓦片/矢量数据/SDK 这些
  **地图缓存**也清掉，并如实显示释放了多少——清的都是可再生内容，记录、照片引用、Key 都不受影响。
- 侧边栏「数据目录」（`describeStorageAsync`）除了报副本 `media` / 封面 `covers` 落在哪、有多少，
  还会**按类型列出各自占了多少**：封面帧 `videoThumbs`、实况视频 `motionVideos`、系统缓存目录
  `cacheDirectory` 里逐个具名子目录（图片缓存 `image_cache`、地图/网页缓存 `WebView`、临时缩略图
  `VideoThumbnails`…，按体积从大到小）、以及缓存合计，最后再做一次真实写入测试。
  目录体积是递归统计的（每层都吞掉"不存在/读不了"的异常，另有 4000 条的扫描上限兜底）。
- 侧边栏「同步相册影像」会**顺带把 `media/` 里没有任何记录引用的影像副本删掉**
  （`pruneOrphanMediaCopies`，在 `src/utils/media.js`）：分享进来又放弃、保存失败、旧数据迁移残留、
  去重时被换掉的旧副本都属于这类孤儿文件，占空间又容易被误以为"还挂在记录上"。
  **记录已经能引用相册原片的那种副本也算多余**：条目上的 `assetId` 还在相册里查得到时，直接换回
  相册原片并删副本，不再要求文件名/大小指纹也吻合（指纹对不上——分享时被改过名、原片在相册里被
  编辑过——正是"记录能显示、副本却一直清不掉"的原因）。重链之后还会再扫一遍副本目录，把这一轮
  刚腾出来的、以及任何记录里已经没有的文件都删掉；删之前会再核一次"还有没有别的条目指向它"，
  同一张影像被两条记录共用时不会误删。
  **两个目录都会扫**：当前落点 `MEDIA_DIR`（原生 `Paths` 可用时是 `Android/data/<包名>/files/media`，
  否则内部 `files/media`）和 1.8.2 之前用的内部 `documentDirectory/media`——搬目录时老副本不会
  自己跟着走，只扫当前目录的话旧残留永远清不掉。判定"被引用"按**文件名**比对记录里所有含
  `/media/` 的字段（宁多留不误删），另外「添加/编辑页草稿」里挂着的影像（`setDraftMediaEntries`）
  也算被引用；只扫 App 自己的目录，相册和用户挑的公共目录一律不碰；**刚生成不到 5 分钟的不动**。
  清理条数与释放空间（含读目录失败的原因）都会在同步结果里如实报出来，不再是"点完没动静"。
  改完这段跑 `node scripts/check-media-sync.mjs` 自检（桩掉 expo 原生模块，在内存文件系统上验证
  "能引用相册的副本 / 指纹能对上的副本 / 没人引用的孤儿副本都会删、找不到原片的副本一定留着"）。
- 去重口径统一在 `makeMediaIndex`（`src/utils/media.js`）：记录里的条目多半是**相册引用**
  （只有 `assetId`），而分享进来的**副本**只有 文件名 + 大小——只比一套永远对不上，
  "同一张照片又被加了一遍"就是这么来的。现在两套口径一起看（`assetId` → 文件名+大小 →
  有一边没大小时比文件名 → 完整 uri），并**先重链再比**：分享到已有记录时，先把副本换成
  相册引用，再和记录里的条目对身份，所以已经记过的照片不会再被追加第二遍。
  应用内选图器的「已添加」角标同样按这两套口径判断（记录里以副本形式存的那张也能认出来）。
- 实现位置：`App.js` 最外层挂 `ShareIntentProvider`，`ShareIntentBridge` 收下文件 → 复制 →
  通过 `navigationRef` 跳到 `ShareTarget` 并带上 `params.sharedMedia`；选「新建印记」时再转到
  「Main / Add」（`AddScreen` 收到后追加到 `selectedImages` 并清掉参数，`shareToken` 保证同一批影像
  重复分享也能再次触发），选某条记录则直接写回那条记录的 `localImages` 并跳到它的详情页。

## 说明（提示性文字都收在这里）

- 页面上不放说明性文字（怎么操作、Key 怎么配、影像存在哪…），侧边栏最后一项**「说明」**
  打开 [HelpModal](src/components/HelpModal.js)，按主题分组列出全部说明；内容用数组维护，
  加一条就是加一行文字。
- 只有两类文字留在页面上：**必须当场做的选择**（按钮、字段标签、占位符、错误弹窗）
  和**随操作即时变化的状态**（同步结果、释放了多少缓存、相册权限状态）。

## 视图与类型

- 首页三段视图：**列表 / 月示 / 地图**。月示图上半是日历（圆点按一级类型着色，最多 3 个 + `+N`），
  下半是当月 / 当日时间线；点日期只看当天，点条目进详情，左右滑日历换月。
- 一级类型四个：**旅票 / 地点 / 娱乐 / 随笔**（随笔下面分 **日记 / 事迹**）。
  所有类型的列表行都会显示统一的类型标签；类型图标统一用 emoji。
- 随笔：标题选填、日期、心情（emoji，必填，预设 5 个 + 可自填）、内容、照片；
  日记多一个天气。随笔没有评分，也不打地图标点。
- 添加印记时，**同一天**已经记过同一个地点（坐标 200 米内或同名）、同一段行程（含同航班号/车次）、
  同一部作品时，表单里会出现一条可点的提示（也能直接跳去看已有的那条）；只是提醒，仍然可以继续保存。
- 新建 / 编辑表单的键盘细节：单行输入框（含年月日时分）按回车或键盘上的「下一项」跳到下一个字段，
  数字格填满自动跳（只有评论是多行，回车仍是换行）；聚焦的输入框如果被输入法挡住，会自动滚到键盘上方。
  点「保存」立刻进入"保存中"（按钮转圈、挡住连点），相册重链 / 封面下载最多等 8 秒，
  不会再出现"点了保存没反应"。
- 列表与月示图的行是同一个组件（`src/components/RecordRow.js`），右滑都能改 / 删；
  行本身刻意做轻（滚动掉帧首先来自"每行挂了多少原生 View"）：右滑的**操作区按需挂载**（手指碰到
  这一行才补上两个按钮 + 图标；Swipeable 是手势 activate 时才量操作区宽度的，第一次右滑照样跟手）、
  **星级用字形画**（整星 `★` / 空星 `☆` / 半星 = 同一颗 `★` 裁掉右半边，5 颗各占 14pt、字形居中，
  全程同一个字号，所以大小完全统一；原来是 5 个矢量图标 = 10 个原生 View）。列表每批 4 行、
  每 24ms 一批，一帧要挂的 View 少了，甩动时就不会"一顿一顿"。
- 侧边栏（抽屉）：打开时**先收键盘**——列表搜索框还聚焦着的时候，键盘会盖住侧边栏下半部分，
  「导出备份 / 导入备份 / 清理缓存 / 说明」那几项点了像没反应、得点好几次；另外地图 WebView
  常驻在最上层且会抢触摸，所以侧边栏 / 设置 / 说明打开时地图层一律 `pointerEvents="none"`。
  弹出动画也调硬调快了（stiffness 230 / mass 0.7，遮罩 150ms），点了马上有反馈。
  行上的日期**分两行**：上面年份、下面 月-日（`2026` / `09-21`），时分只在旅票里有意义，进详情页看。
- 详情页「相关影像」九宫格：**长按 260ms 后拖动 = 调整顺序**（被拖的那张跟手，**滑到哪一格就插到那一格**，其余影像保持相对顺序、整体顺延补位；松手才写回记录）；**长按后原地松手 = 原来的「设为封面」**；轻点仍是全屏查看。三者靠"长按后有没有移动"区分，没有在图片上放任何把手/角标。
  顺序按**条目身份**（assetId / 文件名+大小 / uri）记而不是按下标，松手那一帧读的是**同步维护**的 orderRef
  （setState 可能还没提交，最后一格会被吞掉），跟手位移只用手指位移 + 格子序号换算（不依赖屏幕坐标，
  列表滚动后测量值过期也不跳），拖动期间还会锁住外层 `ScrollView`（否则手势会被滚动容器抢走）。
- 详情页全屏查看器：图片支持双指捏合缩放、双击放大/还原、放大后拖动（视频走原生播放控件）。注意查看器是 RN `Modal`（Android 上独立窗口），里面必须自己再包一层 `GestureHandlerRootView`，否则手势库的上下文不会继承、捏合/双击完全不生效。

## 设计稿

- `node scripts/preview-calendar.mjs` → `demo/month-note-preview.html`：月示图（日历 + 当月时间线）与记事/日记（列表 + 新建流程）的交互设计稿。

## 发布与签名（GitHub Actions 出 APK）

APK 由仓库根目录的 `.github/workflows/android-build.yml` 构建：Actions → 「构建 Android APK」→ Run workflow，
产物同时放到该次运行的 Artifacts 和 Releases 的固定标签 `apk-latest`。流程本身不依赖 EAS，
`expo prebuild + gradlew assembleRelease`，只打 arm64-v8a / armeabi-v7a 两个 ABI。

走 EAS 也一样：`npx eas-cli build -p android --profile preview`（`eas.json` 的 `preview` 里给了
`gradleCommand: ":app:assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a"`，
RN 的 gradle 插件认这个 `reactNativeArchitectures` 属性，所以 EAS 出的 APK **只含这两种 ABI**，
不再是四种全塞一个包——体积小一半左右。要四种全打就把 `gradleCommand` 这一行删掉。
签名仍然走 `assembleRelease`，EAS 注入的那把 keystore 照常生效。

### 用你自己的 keystore 签名

Expo / RN 模板里 release 构建类型默认是 `signingConfig signingConfigs.debug`，也就是用模板自带、
**人人相同的公开 debug key** 签名。这样打出来的包能安装，但部分手机的安装器 / 安全扫描会拦，
而且永远无法覆盖安装用自有 key 签过的包（签名不一致 → 「应用未安装」）。
把下面的 Secrets 配上，构建流程就会自动换成你的 keystore（[apply-release-signing.mjs](scripts/apply-release-signing.mjs)
在 prebuild 之后改写 `android/app/build.gradle`，密码走环境变量、不进命令行）。

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64（单行） |
| `ANDROID_STORE_PASSWORD` | keystore 库密码 |
| `ANDROID_KEY_ALIAS` | `keytool` 里的 `-alias`，例如 `lifelog` |
| `ANDROID_KEY_PASSWORD` | key 密码（与库密码相同就填一样） |

**1）生成 keystore**（JDK 自带 keytool；`release.jks` 是 App 的身份，**别提交进仓库、务必另存备份**，
丢了就无法再覆盖安装已发布的版本）：

```bash
keytool -genkeypair -v -keystore release.jks -alias lifelog \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass 你的库密码 -keypass 你的key密码 \
  -dname "CN=jiyin, OU=lifelog, O=lifelog, L=Beijing, ST=Beijing, C=CN"
```

**2）转成单行 base64**：

```bash
node -e "console.log(require('fs').readFileSync('release.jks').toString('base64'))"   # 跨平台，推荐
# Linux/macOS: base64 -w0 release.jks > keystore.b64
# Windows:     certutil -encode release.jks keystore.b64   （取中间几行拼成一行）
```

**3）** 仓库 Settings → Secrets and variables → Actions → New repository secret，把上表四个加进去。
**4）** 再跑一次「构建 Android APK」。

构建日志里会打印 APK 的证书 SHA-256，并和 keystore 里的指纹逐一比对，**不一致直接失败**，
Release 说明里也会写上这次用的签名指纹，方便和 `keytool -list -v -keystore release.jks` 对一下。
没配 Secrets 时不会失败，只会在日志和 Release 说明里标出「本次用的是 debug 签名」。

手机上如果已经装过别的签名版本的旧包（例如之前用 debug 签名发的），第一次装自有签名的包要先卸载，
之后同签名的更新都能直接覆盖安装。想在本地复用同一套逻辑（例如手动出包）：

```bash
RC_STORE_PASSWORD=xxx RC_KEY_ALIAS=lifelog RC_KEY_PASSWORD=xxx \
  node scripts/apply-release-signing.mjs android/app/build.gradle android/app/release.jks
```

### 之前在 EAS 上打包过？直接用那把 keystore

EAS 把 Android 签名证书托管在 Expo 账号里，**不用另外生成**——而且必须复用同一把，
之前通过 EAS 发出去的版本才能直接覆盖安装（换了 key 就只能先卸载再装）：

1. Expo 网站 → 项目 → **Credentials** → Android → 包名 `com.jiyin.lifelog` 那一行 →
   「Download credentials」，得到一个 JSON：里面是 keystore 的 base64、库密码、key 别名、key 密码。
2. 把 JSON 里的四个值填进上表的四个 Secrets（base64 那一项就是 `keystore`/`keystorePassword` 里的 base64 串）。

也可以用 CLI 取：`npx eas-cli login` 后 `npx eas-cli credentials --platform android`，
选对应包名 → Keystore → 下载（会打印别名与密码，并把 .jks 存到当前目录）。

同一账号下的凭据是**按包名**分开存的：改了 `app.json` 里的 `android.package` 就等于换了一把钥匙
（而且不能让旧包覆盖安装），需要重新配一份凭据。

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
