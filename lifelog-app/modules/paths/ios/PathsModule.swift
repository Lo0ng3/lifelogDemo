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

    AsyncFunction("getFileSize") { (uri: String) -> Int64? in
      let target = self.toFileURL(uri)
      guard let attrs = try? FileManager.default.attributesOfItem(atPath: target.path),
            let size = attrs[.size] as? NSNumber else {
        return nil
      }
      return size.int64Value
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
  }

  private func toFileURL(_ uri: String) -> URL {
    if uri.hasPrefix("file://"), let url = URL(string: uri), url.isFileURL {
      return url
    }
    let raw = uri.hasPrefix("file://") ? String(uri.dropFirst("file://".count)) : uri
    let decoded = raw.removingPercentEncoding ?? raw
    return URL(fileURLWithPath: decoded)
  }
}
