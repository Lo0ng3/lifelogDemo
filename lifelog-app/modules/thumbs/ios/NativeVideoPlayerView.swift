import AVFoundation
import AVKit
import ExpoModulesCore
import Photos
import UIKit

// 苹果原生 AVPlayerViewController 封装：
// - 直接通过 PHImageManager.requestPlayerItem(forVideo:) 流式播放相册原片，零文件拷贝，秒开 4K / HDR / 慢动作 / iCloud 视频；
// - 原生支持系统播控条、画中画（PiP）、隔空播放（AirPlay）、全屏缩放；
// - 也兼容本地沙盒 file:// 视频路径（例如分享副本）。
public final class NativeVideoPlayerView: ExpoView {
  private let playerVC = AVPlayerViewController()
  private var player: AVPlayer?
  private var currentAssetId: String = ""
  private var currentUri: String = ""
  private var isActive: Bool = false
  private var requestId: PHImageRequestID = PHInvalidImageRequestID
  private var attachedToParentVC: Bool = false
  private var loadGeneration: Int = 0

  let onStatusChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = true

    playerVC.showsPlaybackControls = true
    playerVC.allowsPictureInPicturePlayback = true
    playerVC.videoGravity = .resizeAspect
    playerVC.view.backgroundColor = .clear
    playerVC.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(playerVC.view)
  }

  deinit {
    teardownPlayer()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    playerVC.view.frame = bounds
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      attachControllerIfNeeded()
      if isActive && player == nil {
        loadIfNeeded()
      }
    } else {
      player?.pause()
      detachControllerIfNeeded()
    }
  }

  public func setAssetId(_ assetId: String?) {
    let next = (assetId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if next == currentAssetId { return }
    currentAssetId = next
    reloadIfActive()
  }

  public func setUri(_ uri: String?) {
    let next = (uri ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if next == currentUri { return }
    currentUri = next
    if currentAssetId.isEmpty {
      reloadIfActive()
    }
  }

  public func setActive(_ active: Bool) {
    if isActive == active { return }
    isActive = active
    if active {
      if let p = player {
        configureAudioSession()
        p.play()
      } else {
        loadIfNeeded()
      }
    } else {
      cancelRequest()
      player?.pause()
    }
  }

  private func reloadIfActive() {
    teardownPlayer()
    if isActive {
      loadIfNeeded()
    }
  }

  private func loadIfNeeded() {
    guard isActive else { return }
    cancelRequest()
    loadGeneration += 1
    let gen = loadGeneration
    onStatusChange(["status": "loading"])

    if !currentAssetId.isEmpty {
      let stripped = currentAssetId.hasPrefix("ph://")
        ? String(currentAssetId.dropFirst(5))
        : currentAssetId
      if let asset = PHAsset.fetchAssets(withLocalIdentifiers: [stripped], options: nil).firstObject {
        let opts = PHVideoRequestOptions()
        opts.isNetworkAccessAllowed = true
        opts.version = .current
        opts.deliveryMode = .automatic

        requestId = PHImageManager.default().requestPlayerItem(forVideo: asset, options: opts) { [weak self] item, info in
          DispatchQueue.main.async {
            guard let self = self, self.loadGeneration == gen else { return }
            self.requestId = PHInvalidImageRequestID
            if let item = item {
              self.mountPlayer(with: item)
              return
            }
            if let err = info?[PHImageErrorKey] as? Error {
              self.onStatusChange(["status": "error", "message": err.localizedDescription])
            } else {
              self.onStatusChange(["status": "error", "message": "无法加载视频"])
            }
          }
        }
        return
      }
    }

    if !currentUri.isEmpty && !currentUri.hasPrefix("ph://") {
      let url: URL?
      if currentUri.hasPrefix("file://") {
        url = URL(string: currentUri) ?? URL(fileURLWithPath: String(currentUri.dropFirst(7)))
      } else if currentUri.hasPrefix("/") {
        url = URL(fileURLWithPath: currentUri)
      } else {
        url = URL(string: currentUri)
      }
      if let url = url {
        mountPlayer(with: AVPlayerItem(url: url))
        return
      }
    }

    onStatusChange(["status": "error", "message": "视频不存在或未被授权访问"])
  }

  private func mountPlayer(with item: AVPlayerItem) {
    configureAudioSession()
    let p = AVPlayer(playerItem: item)
    p.automaticallyWaitsToMinimizeStalling = true
    self.player = p
    self.playerVC.player = p
    onStatusChange(["status": "ready"])
    if isActive && window != nil {
      p.play()
    }
  }

  private func teardownPlayer() {
    cancelRequest()
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    player = nil
    playerVC.player = nil
  }

  private func cancelRequest() {
    if requestId != PHInvalidImageRequestID {
      PHImageManager.default().cancelImageRequest(requestId)
      requestId = PHInvalidImageRequestID
    }
  }

  private func configureAudioSession() {
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .moviePlayback, options: [])
      try session.setActive(true)
    } catch {}
  }

  private func attachControllerIfNeeded() {
    guard !attachedToParentVC else { return }
    if let parent = findParentViewController() {
      parent.addChild(playerVC)
      playerVC.didMove(toParent: parent)
      attachedToParentVC = true
    }
  }

  private func detachControllerIfNeeded() {
    guard attachedToParentVC else { return }
    playerVC.willMove(toParent: nil)
    playerVC.removeFromParent()
    attachedToParentVC = false
  }

  private func findParentViewController() -> UIViewController? {
    var responder: UIResponder? = self.next
    while let current = responder {
      if let vc = current as? UIViewController {
        return vc
      }
      responder = current.next
    }
    return nil
  }
}
