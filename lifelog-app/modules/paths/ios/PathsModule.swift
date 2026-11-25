import ExpoModulesCore
import Foundation
import WebKit

// iOS 侧的原生文件与缓存模块，与 Android 的 PathsModule 保持一致接口：
// - iOS 的应用文档目录已通过 Info.plist（UIFileSharingEnabled / LSSupportsOpeningDocumentsInPlace）
//   暴露给系统「文件」App，因此 externalFilesDir 返回空串，由 JS 统一落到 documentDirectory；
// - copyFile / deletePath / getFileSize 绕过 expo-file-system 的沙盒路径白名单限制，
//   用于读写/清理 iOS Share Extension 落在 App Group 容器里的分享临时文件；
// - readFileRange 以只读方式按偏移读取文件尾，兼容跨平台迁移过来的 Android 动态照片；
// - clearWebKitCache 清理 WKWebView 的磁盘/内存/Fetch 缓存（不碰 localStorage），
//   补齐 react-native-webview 在 iOS 上没有 clearCache 方法的缺口。
public class PathsModule: Module {
  private let appleSearchSession = AppleMapSearchSession()

  private struct StorageSubEntry {
    var bucket: String
    var group: String
    var label: String
    var bytes: Int64
    var files: Int
  }

  private struct StorageFileEntry {
    let name: String
    let relPath: String
    let bytes: Int64
    let bucket: String
    let subKey: String
    let subLabel: String
  }

  public func definition() -> ModuleDefinition {
    Name("Paths")

    Property("externalFilesDir") { "" }

    Function("getExternalFilesDir") { "" }

    AsyncFunction("ensureDir") { (uri: String) -> Bool in
      let url = self.toFileURL(uri)
      do {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return true
      } catch {
        return false
      }
    }

    AsyncFunction("copyFile") { (from: String, to: String) -> Bool in
      let src = self.toFileURL(from)
      let dst = self.toFileURL(to)
      let fm = FileManager.default
      do {
        try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: dst.path) {
          try fm.removeItem(at: dst)
        }
        try fm.copyItem(at: src, to: dst)
        return fm.fileExists(atPath: dst.path)
      } catch {
        return false
      }
    }

    AsyncFunction("writeFileBase64") { (uri: String, base64: String) -> Bool in
      guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
        return false
      }
      let dst = self.toFileURL(uri)
      do {
        try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: dst, options: .atomic)
        return true
      } catch {
        return false
      }
    }

    AsyncFunction("deletePath") { (uri: String) -> Bool in
      let target = self.toFileURL(uri)
      let fm = FileManager.default
      if !fm.fileExists(atPath: target.path) {
        return true
      }
      do {
        try fm.removeItem(at: target)
        return true
      } catch {
        return false
      }
    }

    // 按沙盒相对路径（如 "Documents/xxx"、"Library/Caches/xxx"、"tmp/xxx"）安全删除单个文件：
    // 严格限定在 NSHomeDirectory() 内，禁止路径穿越与删除 AsyncStorage 核心数据库。
    AsyncFunction("deleteSandboxFile") { (relPath: String) -> Bool in
      let cleaned = relPath.trimmingCharacters(in: .whitespacesAndNewlines)
      if cleaned.isEmpty || cleaned.hasPrefix("/") || cleaned.contains("..") || cleaned.contains("RCTAsyncLocalStorage") {
        return false
      }
      let homeURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL
      let homePrefix = homeURL.path.hasSuffix("/") ? homeURL.path : homeURL.path + "/"
      let target = homeURL.appendingPathComponent(cleaned).standardizedFileURL
      guard target.path.hasPrefix(homePrefix) else { return false }
      let fm = FileManager.default
      if !fm.fileExists(atPath: target.path) {
        return true
      }
      do {
        try fm.removeItem(at: target)
        return !fm.fileExists(atPath: target.path)
      } catch {
        return false
      }
    }

    AsyncFunction("getFileSize") { (uri: String) -> Double? in
      let target = self.toFileURL(uri)
      guard let attrs = try? FileManager.default.attributesOfItem(atPath: target.path),
            let size = attrs[.size] as? NSNumber else {
        return nil
      }
      return size.doubleValue
    }

    AsyncFunction("readFileRange") { (uri: String, offset: Double, length: Double) -> Data in
      let target = self.toFileURL(uri)
      guard let attrs = try? FileManager.default.attributesOfItem(atPath: target.path),
            let fileSize = (attrs[.size] as? NSNumber)?.int64Value,
            fileSize > 0 else {
        return Data()
      }
      let start = min(max(Int64(offset), 0), fileSize)
      let len = min(max(Int64(length), 0), fileSize - start)
      guard len > 0 else { return Data() }
      do {
        let handle = try FileHandle(forReadingFrom: target)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(start))
        return (try handle.read(upToCount: Int(len))) ?? Data()
      } catch {
        return Data()
      }
    }

    AsyncFunction("clearWebKitCache") { (promise: Promise) in
      let types: Set<String> = [
        WKWebsiteDataTypeDiskCache,
        WKWebsiteDataTypeMemoryCache,
        WKWebsiteDataTypeFetchCache,
        WKWebsiteDataTypeOfflineWebApplicationCache,
      ]
      WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) {
        promise.resolve(true)
      }
    }.runOnQueue(.main)

    // 苹果原生 MapKit 地点搜索联想（免密钥，国内走高德 POI 库）
    AsyncFunction("searchApplePlaces") { (query: String, promise: Promise) in
      self.appleSearchSession.searchPlaces(query: query) { items in
        promise.resolve(items)
      }
    }.runOnQueue(.main)

    // 苹果原生 MapKit 正地理编码（手输地名没点联想时的坐标兜底）
    AsyncFunction("geocodeApplePlace") { (query: String, promise: Promise) in
      self.appleSearchSession.geocodePlace(query: query) { result in
        promise.resolve(result)
      }
    }.runOnQueue(.main)

    // 清理应用沙盒 tmp/ 下的所有临时文件（如早期导出的实况/视频临时缓存）
    AsyncFunction("clearTempFiles") { () -> Double in
      let fm = FileManager.default
      let tmpDir = fm.temporaryDirectory
      var freed: Int64 = 0
      guard let items = try? fm.contentsOfDirectory(at: tmpDir, includingPropertiesForKeys: nil) else {
        return 0
      }
      for item in items {
        freed += self.allocatedSizeOf(url: item)
        try? fm.removeItem(at: item)
      }
      return Double(freed)
    }

    // 与 iOS「设置 → 通用 → iPhone 储存空间 → 文稿与数据」同口径的全沙盒扫描：
    // 遍历整个 NSHomeDirectory()（Documents / Library / tmp），按文件系统实际占用块（totalFileAllocatedSizeKey）汇总并分类，
    // 保证各项相加严格等于系统统计的「文稿与数据」总占用；同时返回二级子项与各大类下体积最大的文件列表供点开查看明细。
    AsyncFunction("getStorageBreakdown") { () -> [String: Any] in
      let fm = FileManager.default
      let homeURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL
      let homePrefix = homeURL.path.hasSuffix("/") ? homeURL.path : homeURL.path + "/"

      var buckets: [String: (bytes: Int64, files: Int)] = [
        "records": (0, 0),   // 记录、内部备份与头像（Application Support / internal-backup / profile）
        "covers": (0, 0),    // 封面小图与视频预览帧（covers / videoPosters / videoThumbs）
        "media": (0, 0),     // 本地媒体副本（Documents/media）
        "imageCache": (0, 0),// 图片与缩略图缓存（SDImageCache / expo-image / thumbs / ImageManipulator）
        "mapCache": (0, 0),  // 地图与网页缓存（WebKit / HTTPStorages / Cookies / URLCache）
        "temp": (0, 0),      // 临时文件（tmp / motionVideos / backups / VideoThumbnails）
        "system": (0, 0),    // 其余系统沙盒文件（Preferences / SplashBoard / Saved State 等）
      ]

      var subBuckets: [String: StorageSubEntry] = [:]
      var topFilesByGroup: [String: [StorageFileEntry]] = [
        "app": [],
        "imageCache": [],
        "mapCache": [],
        "other": [],
      ]
      let maxTopFiles = 20

      let keys: Set<URLResourceKey> = [
        .isRegularFileKey,
        .totalFileAllocatedSizeKey,
        .fileAllocatedSizeKey,
        .fileSizeKey,
      ]
      var totalBytes: Int64 = 0
      var totalFiles: Int = 0

      if let enumerator = fm.enumerator(
        at: homeURL,
        includingPropertiesForKeys: Array(keys),
        options: [],
        errorHandler: nil
      ) {
        for case let fileURL as URL in enumerator {
          guard let vals = try? fileURL.resourceValues(forKeys: keys),
                vals.isRegularFile == true else {
            continue
          }
          let sz = Int64(vals.totalFileAllocatedSize ?? vals.fileAllocatedSize ?? vals.fileSize ?? 0)
          let fullPath = fileURL.standardizedFileURL.path
          let rel = fullPath.hasPrefix(homePrefix)
            ? String(fullPath.dropFirst(homePrefix.count))
            : fullPath
          let detail = self.classifySandboxDetail(rel)
          if var cur = buckets[detail.bucket] {
            cur.bytes += sz
            cur.files += 1
            buckets[detail.bucket] = cur
          }
          if var sub = subBuckets[detail.subKey] {
            sub.bytes += sz
            sub.files += 1
            subBuckets[detail.subKey] = sub
          } else {
            subBuckets[detail.subKey] = StorageSubEntry(
              bucket: detail.bucket,
              group: detail.group,
              label: detail.subLabel,
              bytes: sz,
              files: 1
            )
          }
          if sz > 0 {
            var arr = topFilesByGroup[detail.group] ?? []
            arr.append(StorageFileEntry(
              name: fileURL.lastPathComponent,
              relPath: rel,
              bytes: sz,
              bucket: detail.bucket,
              subKey: detail.subKey,
              subLabel: detail.subLabel
            ))
            if arr.count > maxTopFiles * 3 {
              arr.sort { $0.bytes > $1.bytes }
              arr = Array(arr.prefix(maxTopFiles))
            }
            topFilesByGroup[detail.group] = arr
          }
          totalBytes += sz
          totalFiles += 1
        }
      }

      var resultBuckets: [String: [String: Any]] = [:]
      for (k, v) in buckets {
        resultBuckets[k] = ["bytes": Double(v.bytes), "files": v.files]
      }
      var resultSubBuckets: [String: [String: Any]] = [:]
      for (k, v) in subBuckets {
        resultSubBuckets[k] = [
          "bucket": v.bucket,
          "group": v.group,
          "label": v.label,
          "bytes": Double(v.bytes),
          "files": v.files,
        ]
      }
      var resultTopFiles: [String: [[String: Any]]] = [:]
      for (groupKey, entries) in topFilesByGroup {
        let sorted = entries.sorted { $0.bytes > $1.bytes }.prefix(maxTopFiles)
        resultTopFiles[groupKey] = sorted.map { (e: StorageFileEntry) -> [String: Any] in
          [
            "name": e.name,
            "relPath": e.relPath,
            "bytes": Double(e.bytes),
            "bucket": e.bucket,
            "subKey": e.subKey,
            "subLabel": e.subLabel,
          ]
        }
      }
      return [
        "totalBytes": Double(totalBytes),
        "totalFiles": totalFiles,
        "buckets": resultBuckets,
        "subBuckets": resultSubBuckets,
        "topFiles": resultTopFiles,
      ]
    }

    View(LiquidGlassView.self) {
      Prop("cornerRadius") { (view: LiquidGlassView, value: Double) in
        view.setCornerRadius(value)
      }
      Prop("isDark") { (view: LiquidGlassView, value: Bool) in
        view.setIsDark(value)
      }
      Prop("interactive") { (view: LiquidGlassView, value: Bool) in
        view.setInteractive(value)
      }
    }

    View(NativeSegmentedControlView.self) {
      Events("onValueChange")
      Prop("segments") { (view: NativeSegmentedControlView, value: [String]) in
        view.setSegments(value)
      }
      Prop("selectedIndex") { (view: NativeSegmentedControlView, value: Int) in
        view.setSelectedIndex(value)
      }
      Prop("isDark") { (view: NativeSegmentedControlView, value: Bool) in
        view.setIsDark(value)
      }
    }

    View(NativeTabBarView.self) {
      Events("onValueChange")
      Prop("titles") { (view: NativeTabBarView, value: [String]) in
        view.setTitles(value)
      }
      Prop("icons") { (view: NativeTabBarView, value: [String]) in
        view.setIcons(value)
      }
      Prop("selectedIcons") { (view: NativeTabBarView, value: [String]) in
        view.setSelectedIcons(value)
      }
      Prop("selectedIndex") { (view: NativeTabBarView, value: Int) in
        view.setSelectedIndex(value)
      }
      Prop("isDark") { (view: NativeTabBarView, value: Bool) in
        view.setIsDark(value)
      }
      Prop("activeColor") { (view: NativeTabBarView, value: String) in
        view.setActiveColor(value)
      }
      Prop("inactiveColor") { (view: NativeTabBarView, value: String) in
        view.setInactiveColor(value)
      }
    }

    View(NativeAppleMapView.self) {
      Events("onPinPress", "onMapPress", "onSelectedPinMove")
      Prop("isDark") { (view: NativeAppleMapView, value: Bool) in
        view.setIsDark(value)
      }
      Prop("dataJson") { (view: NativeAppleMapView, value: String) in
        view.setDataJson(value)
      }
      Prop("commandJson") { (view: NativeAppleMapView, value: String) in
        view.setCommandJson(value)
      }
    }

    View(NativeMonthPickerView.self) {
      Events("onChange")
      Prop("minYear") { (view: NativeMonthPickerView, value: Int) in
        view.setMinYear(value)
      }
      Prop("maxYear") { (view: NativeMonthPickerView, value: Int) in
        view.setMaxYear(value)
      }
      Prop("year") { (view: NativeMonthPickerView, value: Int) in
        view.setYear(value)
      }
      Prop("month") { (view: NativeMonthPickerView, value: Int) in
        view.setMonth(value)
      }
      Prop("isDark") { (view: NativeMonthPickerView, value: Bool) in
        view.setIsDark(value)
      }
    }
  }

  private func toFileURL(_ uri: String) -> URL {
    if uri.hasPrefix("file://"), let url = URL(string: uri), url.isFileURL {
      return url
    }
    let raw = uri.hasPrefix("file://") ? String(uri.dropFirst("file://".count)) : uri
    let decoded = raw.removingPercentEncoding ?? raw
    return URL(fileURLWithPath: decoded)
  }

  private func allocatedSizeOf(url: URL) -> Int64 {
    let keys: Set<URLResourceKey> = [.isRegularFileKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .fileSizeKey]
    if let vals = try? url.resourceValues(forKeys: keys), vals.isRegularFile == true {
      return Int64(vals.totalFileAllocatedSize ?? vals.fileAllocatedSize ?? vals.fileSize ?? 0)
    }
    var sum: Int64 = 0
    if let en = FileManager.default.enumerator(at: url, includingPropertiesForKeys: Array(keys)) {
      for case let child as URL in en {
        if let vals = try? child.resourceValues(forKeys: keys), vals.isRegularFile == true {
          sum += Int64(vals.totalFileAllocatedSize ?? vals.fileAllocatedSize ?? vals.fileSize ?? 0)
        }
      }
    }
    return sum
  }

  private func classifySandboxDetail(_ rel: String) -> (bucket: String, group: String, subKey: String, subLabel: String) {
    if rel.hasPrefix("tmp/") || rel == "tmp" {
      return ("temp", "other", "tmp", "系统临时目录 (tmp)")
    }
    if rel.hasPrefix("Documents/media/") {
      return ("media", "app", "media", "本地媒体副本")
    }
    if rel.hasPrefix("Documents/covers/") {
      return ("covers", "app", "covers", "封面小图")
    }
    if rel.hasPrefix("Documents/videoPosters/") {
      return ("covers", "app", "videoPosters", "视频封面图")
    }
    if rel.hasPrefix("Documents/videoThumbs/") {
      return ("covers", "app", "videoThumbs", "视频预览帧")
    }
    if rel.hasPrefix("Documents/motionVideos/") {
      return ("temp", "other", "motionVideos", "实况动效临时文件")
    }
    if rel.hasPrefix("Documents/internal-backup/") {
      return ("records", "app", "internalBackup", "本地自动备份")
    }
    if rel.hasPrefix("Documents/profile/") {
      return ("records", "app", "profile", "个人头像与资料")
    }
    if rel.hasPrefix("Library/Application Support/") {
      if rel.contains("RCTAsyncLocalStorage") {
        return ("records", "app", "asyncStorage", "记录与设置数据")
      }
      return ("records", "app", "appSupport", "应用支持数据")
    }
    if rel.hasPrefix("Library/WebKit/") || rel.hasPrefix("Library/Caches/WebKit/") {
      return ("mapCache", "mapCache", "webKit", "地图与网页缓存")
    }
    if rel.hasPrefix("Library/HTTPStorages/")
      || rel.hasPrefix("Library/Cookies/")
      || rel.hasPrefix("Library/Caches/com.jiyin.lifelog/") {
      return ("mapCache", "mapCache", "httpCache", "网络与瓦片缓存")
    }
    if rel.hasPrefix("Library/Caches/backups/") {
      return ("temp", "other", "cacheBackups", "备份导出临时文件")
    }
    if rel.hasPrefix("Library/Caches/VideoThumbnails/") {
      return ("temp", "other", "videoThumbnailsCache", "视频帧提取缓存")
    }
    if rel.hasPrefix("Library/Caches/com.hackemist.SDImageCache/")
      || rel.hasPrefix("Library/Caches/org.hackemist.SDImageCache/")
      || rel.hasPrefix("Library/Caches/expo-image/")
      || rel.hasPrefix("Library/Caches/image_cache/") {
      return ("imageCache", "imageCache", "imageDiskCache", "图片磁盘缓存")
    }
    if rel.hasPrefix("Library/Caches/thumbs/") {
      return ("imageCache", "imageCache", "thumbs", "选图器缩略图缓存")
    }
    if rel.hasPrefix("Library/Caches/ImageManipulator/") {
      return ("imageCache", "imageCache", "imageManipulator", "图片处理缓存")
    }
    if rel.hasPrefix("Library/Caches/") {
      let rest = String(rel.dropFirst("Library/Caches/".count))
      let top = rest.split(separator: "/").first.map(String.init) ?? "Caches"
      return ("mapCache", "mapCache", "cache:\(top)", "缓存 (\(top))")
    }
    if rel.hasPrefix("Documents/") {
      return ("records", "app", "documentsOther", "其他文稿文件")
    }
    if rel.hasPrefix("Library/Preferences/") {
      return ("system", "other", "preferences", "偏好设置")
    }
    if rel.hasPrefix("Library/SplashBoard/") {
      return ("system", "other", "splashBoard", "启动屏快照")
    }
    if rel.hasPrefix("Library/Saved Application State/") {
      return ("system", "other", "savedState", "界面状态恢复")
    }
    let parts = rel.split(separator: "/")
    let top = parts.count >= 2 && parts[0] == "Library" ? String(parts[1]) : String(parts.first ?? "系统")
    return ("system", "other", "sys:\(top)", "系统文件 (\(top))")
  }
}
