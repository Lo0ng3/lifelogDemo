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
    // 保证各项相加严格等于系统统计的「文稿与数据」总占用。
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
          let bucket = self.classifySandboxPath(rel)
          if var cur = buckets[bucket] {
            cur.bytes += sz
            cur.files += 1
            buckets[bucket] = cur
          }
          totalBytes += sz
          totalFiles += 1
        }
      }

      var resultBuckets: [String: [String: Any]] = [:]
      for (k, v) in buckets {
        resultBuckets[k] = ["bytes": Double(v.bytes), "files": v.files]
      }
      return [
        "totalBytes": Double(totalBytes),
        "totalFiles": totalFiles,
        "buckets": resultBuckets,
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

  private func classifySandboxPath(_ rel: String) -> String {
    if rel.hasPrefix("tmp/") || rel == "tmp" { return "temp" }
    if rel.hasPrefix("Documents/media/") { return "media" }
    if rel.hasPrefix("Documents/covers/")
      || rel.hasPrefix("Documents/videoPosters/")
      || rel.hasPrefix("Documents/videoThumbs/") {
      return "covers"
    }
    if rel.hasPrefix("Documents/motionVideos/") { return "temp" }
    if rel.hasPrefix("Documents/internal-backup/")
      || rel.hasPrefix("Documents/profile/")
      || rel.hasPrefix("Library/Application Support/") {
      return "records"
    }
    if rel.hasPrefix("Library/WebKit/")
      || rel.hasPrefix("Library/HTTPStorages/")
      || rel.hasPrefix("Library/Cookies/")
      || rel.hasPrefix("Library/Caches/WebKit/")
      || rel.hasPrefix("Library/Caches/com.jiyin.lifelog/") {
      return "mapCache"
    }
    if rel.hasPrefix("Library/Caches/backups/")
      || rel.hasPrefix("Library/Caches/VideoThumbnails/") {
      return "temp"
    }
    if rel.hasPrefix("Library/Caches/com.hackemist.SDImageCache/")
      || rel.hasPrefix("Library/Caches/org.hackemist.SDImageCache/")
      || rel.hasPrefix("Library/Caches/expo-image/")
      || rel.hasPrefix("Library/Caches/thumbs/")
      || rel.hasPrefix("Library/Caches/ImageManipulator/")
      || rel.hasPrefix("Library/Caches/image_cache/") {
      return "imageCache"
    }
    if rel.hasPrefix("Library/Caches/") {
      return "mapCache"
    }
    if rel.hasPrefix("Documents/") {
      return "records"
    }
    return "system"
  }
}
