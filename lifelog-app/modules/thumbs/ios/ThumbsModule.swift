import AVFoundation
import ExpoModulesCore
import Photos
import UIKit

// iOS 原生 PhotoKit 媒体工具模块：
// 1. getThumbnailAsync：全部解码与写盘移到后台并发队列（绝不阻塞主线程），供封面/视频帧使用；
// 2. getAssetFileSizeAsync：通过 PHAssetResource 直接读字节数，不触发 iCloud 下载；
// 3. getLivePhotoStatusAsync：毫秒级读取 PHAsset.mediaSubtypes.contains(.photoLive)；
// 4. getLivePhotoVideoUriAsync：绕开 expo-media-library 的 opportunistic 二次回调 Bug，
//    直接用 PHAssetResourceManager 导出 .fullSizePairedVideo / .pairedVideo 到 tmp/；
// 5. getPlayableVideoUriAsync：把相册视频（含 4K/HDR/慢动作/iCloud）导出到应用沙盒 tmp/，
//    彻底解决 expo-av 无法直接读取 /var/mobile/Media/DCIM/ 导致视频无法播放的问题。
public class ThumbsModule: Module {
  private let workQueue = DispatchQueue(label: "com.jiyin.thumbs.work", qos: .userInitiated, attributes: .concurrent)
  private let encodeSemaphore = DispatchSemaphore(value: 4)

  public func definition() -> ModuleDefinition {
    Name("Thumbs")

    AsyncFunction("getThumbnailAsync") { (assetId: String, isVideo: Bool, size: Double, promise: Promise) in
      self.workQueue.async {
        let px = min(max(Int(size), 64), 1024)
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = caches.appendingPathComponent("thumbs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let kind = isVideo ? "v" : "i"
        let safeId = self.sanitizeId(assetId)
        let dest = dir.appendingPathComponent("thumb_\(kind)_\(safeId)_\(px).jpg")

        if self.nonEmptyFileExists(at: dest) {
          promise.resolve(["uri": dest.absoluteString])
          return
        }

        guard let asset = self.fetchAsset(assetId) else {
          promise.reject("ERR_NOT_FOUND", "照片不存在或未被授权访问")
          return
        }

        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
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
          guard let image = image else {
            promise.reject("ERR_THUMBNAIL", "无法生成缩略图")
            return
          }
          // PHImageManager 回调默认在主线程：JPEG 压缩与写盘必须切回后台队列，避免卡死界面
          self.workQueue.async {
            self.encodeSemaphore.wait()
            defer { self.encodeSemaphore.signal() }
            guard let data = image.jpegData(compressionQuality: 0.82) else {
              promise.reject("ERR_THUMBNAIL", "缩略图编码失败")
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
      }
    }

    AsyncFunction("getAssetFileSizeAsync") { (assetId: String) -> Double? in
      guard let asset = self.fetchAsset(assetId) else { return nil }
      let resources = PHAssetResource.assetResources(for: asset)
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

    // 直接读 PhotoKit 的 mediaSubtypes，不解码图片、不下载 iCloud，微秒级判定是否实况照片
    AsyncFunction("getLivePhotoStatusAsync") { (assetId: String) -> Bool in
      guard let asset = self.fetchAsset(assetId) else { return false }
      return asset.mediaSubtypes.contains(.photoLive)
    }

    // 导出实况照片的配对视频到 tmp/livePhotos/（兼容编辑过的 .fullSizePairedVideo 与原版 .pairedVideo）
    AsyncFunction("getLivePhotoVideoUriAsync") { (assetId: String, promise: Promise) in
      self.workQueue.async {
        guard let asset = self.fetchAsset(assetId) else {
          promise.resolve(nil)
          return
        }
        guard asset.mediaSubtypes.contains(.photoLive) else {
          promise.resolve(nil)
          return
        }
        let resources = PHAssetResource.assetResources(for: asset)
        let videoRes = resources.first(where: { $0.type == .fullSizePairedVideo })
          ?? resources.first(where: { $0.type == .pairedVideo })
        guard let res = videoRes else {
          promise.resolve(nil)
          return
        }
        let ext = (res.originalFilename as NSString).pathExtension
        let safeExt = ext.isEmpty ? "mov" : ext.lowercased()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("livePhotos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("live_\(self.sanitizeId(assetId)).\(safeExt)")

        if self.nonEmptyFileExists(at: dest) {
          promise.resolve(dest.absoluteString)
          return
        }
        try? FileManager.default.removeItem(at: dest)

        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = true
        PHAssetResourceManager.default().writeData(for: res, toFile: dest, options: opts) { error in
          if let error = error {
            try? FileManager.default.removeItem(at: dest)
            promise.reject("ERR_LIVE_VIDEO", error.localizedDescription)
          } else if self.nonEmptyFileExists(at: dest) {
            promise.resolve(dest.absoluteString)
          } else {
            promise.resolve(nil)
          }
        }
      }
    }

    // 导出可播放的沙盒内视频文件（tmp/playableVideos/），供 expo-av 稳定播放
    AsyncFunction("getPlayableVideoUriAsync") { (assetId: String, promise: Promise) in
      self.workQueue.async {
        guard let asset = self.fetchAsset(assetId) else {
          promise.reject("ERR_NOT_FOUND", "视频不存在或未被授权访问")
          return
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("playableVideos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safeId = self.sanitizeId(assetId)

        let resources = PHAssetResource.assetResources(for: asset)
        let videoRes = resources.first(where: { $0.type == .fullSizeVideo })
          ?? resources.first(where: { $0.type == .video })

        if let res = videoRes {
          let rawExt = (res.originalFilename as NSString).pathExtension.lowercased()
          let ext = ["mov", "mp4", "m4v"].contains(rawExt) ? rawExt : "mov"
          let dest = dir.appendingPathComponent("vid_\(safeId).\(ext)")
          if self.nonEmptyFileExists(at: dest) {
            promise.resolve(dest.absoluteString)
            return
          }
          try? FileManager.default.removeItem(at: dest)

          let opts = PHAssetResourceRequestOptions()
          opts.isNetworkAccessAllowed = true
          PHAssetResourceManager.default().writeData(for: res, toFile: dest, options: opts) { error in
            if error == nil && self.nonEmptyFileExists(at: dest) {
              promise.resolve(dest.absoluteString)
            } else {
              try? FileManager.default.removeItem(at: dest)
              // 兜底：慢动作 / 特殊编辑视频走 AVAssetExportSession 导出
              self.exportVideoFallback(asset: asset, dest: dir.appendingPathComponent("vid_\(safeId).mp4"), promise: promise)
            }
          }
          return
        }

        self.exportVideoFallback(asset: asset, dest: dir.appendingPathComponent("vid_\(safeId).mp4"), promise: promise)
      }
    }

    View(NativeLivePhotoView.self) {
      Events("onPlaybackChange", "onLoadState")
      Prop("assetId") { (view: NativeLivePhotoView, value: String) in
        view.setAssetId(value)
      }
      Prop("active") { (view: NativeLivePhotoView, value: Bool) in
        view.setActive(value)
      }
      Prop("playTrigger") { (view: NativeLivePhotoView, value: Int) in
        view.setPlayTrigger(value)
      }
    }

    View(NativeVideoPlayerView.self) {
      Events("onStatusChange")
      Prop("assetId") { (view: NativeVideoPlayerView, value: String?) in
        view.setAssetId(value)
      }
      Prop("uri") { (view: NativeVideoPlayerView, value: String?) in
        view.setUri(value)
      }
      Prop("active") { (view: NativeVideoPlayerView, value: Bool) in
        view.setActive(value)
      }
    }
  }

  private func exportVideoFallback(asset: PHAsset, dest: URL, promise: Promise) {
    if nonEmptyFileExists(at: dest) {
      promise.resolve(dest.absoluteString)
      return
    }
    try? FileManager.default.removeItem(at: dest)
    let opts = PHVideoRequestOptions()
    opts.isNetworkAccessAllowed = true
    opts.version = .current
    opts.deliveryMode = .automatic
    PHImageManager.default().requestExportSession(
      forVideo: asset,
      options: opts,
      exportPreset: AVAssetExportPresetHighestQuality
    ) { session, _ in
      guard let session = session else {
        promise.reject("ERR_VIDEO_EXPORT", "无法准备视频播放文件")
        return
      }
      session.outputURL = dest
      session.outputFileType = session.supportedFileTypes.contains(.mp4) ? .mp4 : .mov
      session.shouldOptimizeForNetworkUse = true
      session.exportAsynchronously {
        if session.status == .completed && self.nonEmptyFileExists(at: dest) {
          promise.resolve(dest.absoluteString)
        } else {
          try? FileManager.default.removeItem(at: dest)
          promise.reject("ERR_VIDEO_EXPORT", session.error?.localizedDescription ?? "视频导出失败")
        }
      }
    }
  }

  private func fetchAsset(_ assetId: String) -> PHAsset? {
    if let direct = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject {
      return direct
    }
    // 兼容只带 UUID 前缀或带 ph:// 的情况
    let stripped = assetId.hasPrefix("ph://") ? String(assetId.dropFirst(5)) : assetId
    return PHAsset.fetchAssets(withLocalIdentifiers: [stripped], options: nil).firstObject
  }

  private func sanitizeId(_ assetId: String) -> String {
    return assetId
      .replacingOccurrences(of: "ph://", with: "")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: ":", with: "_")
  }

  private func nonEmptyFileExists(at url: URL) -> Bool {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = (attrs[.size] as? NSNumber)?.int64Value else {
      return false
    }
    return size > 0
  }
}
