import ExpoModulesCore
import Photos
import UIKit

// 系统微缩略图管道：PHImageManager.requestImage 是系统相册/选择器同款的封面来源，
// 照片与视频都能出帧，结果落盘缓存目录后以 file:// 返回，重复请求零开销。
// 同时提供 getAssetFileSizeAsync，通过 PHAssetResource 直接读取原片字节数，
// 避免对 ph:// 或沙盒外 DCIM 路径调用 FileSystem.getInfoAsync 失败，也不会触发 iCloud 下载。
public class ThumbsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Thumbs")

    AsyncFunction("getThumbnailAsync") { (assetId: String, isVideo: Bool, size: Double, promise: Promise) in
      let px = min(max(Int(size), 64), 1024)
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      let dir = caches.appendingPathComponent("thumbs", isDirectory: true)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let kind = isVideo ? "v" : "i"
      // iOS 的 PHAsset.localIdentifier 包含 "/"（如 UUID/L0/001），直接拼进文件名会变成不存在的子目录
      let safeId = assetId
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: ":", with: "_")
      let dest = dir.appendingPathComponent("thumb_\(kind)_\(safeId)_\(px).jpg")

      if let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path),
         let fileSize = (attrs[.size] as? NSNumber)?.int64Value,
         fileSize > 0 {
        promise.resolve(["uri": dest.absoluteString])
        return
      }

      guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
        promise.reject("ERR_NOT_FOUND", "照片不存在或未被授权访问")
        return
      }

      let options = PHImageRequestOptions()
      options.deliveryMode = .highQualityFormat
      options.resizeMode = .fast
      options.isNetworkAccessAllowed = true   // iCloud 图库：允许联网拉取封面
      options.version = .current

      let lock = NSLock()
      var settled = false
      PHImageManager.default().requestImage(
        for: asset,
        targetSize: CGSize(width: px, height: px),
        contentMode: .aspectFill,
        options: options
      ) { image, info in
        let isDegraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
        if isDegraded { return }

        lock.lock()
        if settled {
          lock.unlock()
          return
        }
        settled = true
        lock.unlock()

        if let cancelled = info?[PHImageCancelledKey] as? Bool, cancelled {
          promise.reject("ERR_CANCELLED", "缩略图请求已取消")
          return
        }
        if let err = info?[PHImageErrorKey] as? Error {
          promise.reject("ERR_THUMBNAIL", err.localizedDescription)
          return
        }
        guard let image = image, let data = image.jpegData(compressionQuality: 0.85) else {
          promise.reject("ERR_THUMBNAIL", "无法生成缩略图")
          return
        }
        do {
          try data.write(to: dest, options: .atomic)
          promise.resolve(["uri": dest.absoluteString])
        } catch {
          promise.reject("ERR_WRITE", error.localizedDescription)
        }
      }
    }

    AsyncFunction("getAssetFileSizeAsync") { (assetId: String) -> Double? in
      guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
        return nil
      }
      let resources = PHAssetResource.assetResources(for: asset)
      // 优先取主图/主视频资源（避开 Live Photo 的配对视频或编辑数据），获取准确文件体积
      let preferredTypes: [PHAssetResourceType] = asset.mediaType == .video
        ? [.fullSizeVideo, .video]
        : [.fullSizePhoto, .photo]
      for preferred in preferredTypes {
        if let res = resources.first(where: { $0.type == preferred }),
           let size = (res.value(forKey: "fileSize") as? NSNumber)?.doubleValue,
           size > 0 {
          return size
        }
      }
      for res in resources {
        if let size = (res.value(forKey: "fileSize") as? NSNumber)?.doubleValue, size > 0 {
          return size
        }
      }
      return nil
    }
  }
}
