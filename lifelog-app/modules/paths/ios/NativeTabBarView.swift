import ExpoModulesCore
import UIKit

// 苹果原生 UISegmentedControl 底部导航栏封装：
// - 与顶部「列表/日历/地图」及「外观/类型」分段控件使用完全一致的原生 UISegmentedControl；
// - iOS 26+ 自动获得苹果官方液态玻璃胶囊容器与交互式跟手滑动放大透镜，手感和样式与顶部完全统一；
// - 通过渲染图标+文字合成图片（alwaysOriginal）实现底部 Tab 的上下图文排版与选中/未选中配色切换。
public final class NativeTabBarView: ExpoView {
  private let segmentedControl = UISegmentedControl()
  private var titles: [String] = []
  private var icons: [String] = []
  private var selectedIcons: [String] = []
  private var currentIndex: Int = 0
  private var isDarkMode: Bool = false
  private var activeColorHex: String = "#1D63ED"
  private var inactiveColorHex: String = "#5E6675"
  private var isUpdatingProgrammatically = false

  let onValueChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = false

    segmentedControl.apportionsSegmentWidthsByContent = false
    segmentedControl.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    segmentedControl.addTarget(self, action: #selector(handleValueChanged(_:)), for: .valueChanged)
    addSubview(segmentedControl)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    segmentedControl.frame = bounds
  }

  public func setTitles(_ value: [String]) {
    if value == titles { return }
    let countChanged = value.count != titles.count
    titles = value
    if countChanged {
      rebuildSegments()
    } else {
      refreshSegmentImages()
    }
  }

  public func setIcons(_ value: [String]) {
    if value == icons { return }
    icons = value
    refreshSegmentImages()
  }

  public func setSelectedIcons(_ value: [String]) {
    if value == selectedIcons { return }
    selectedIcons = value
    refreshSegmentImages()
  }

  public func setSelectedIndex(_ index: Int) {
    currentIndex = index
    guard index >= 0 && index < segmentedControl.numberOfSegments else { return }
    if segmentedControl.selectedSegmentIndex != index {
      isUpdatingProgrammatically = true
      segmentedControl.selectedSegmentIndex = index
      isUpdatingProgrammatically = false
    }
    refreshSegmentImages()
  }

  public func setIsDark(_ isDark: Bool) {
    if isDarkMode == isDark && segmentedControl.overrideUserInterfaceStyle != .unspecified {
      return
    }
    isDarkMode = isDark
    segmentedControl.overrideUserInterfaceStyle = isDark ? .dark : .light
    refreshSegmentImages()
  }

  public func setActiveColor(_ hex: String) {
    if activeColorHex == hex { return }
    activeColorHex = hex
    refreshSegmentImages()
  }

  public func setInactiveColor(_ hex: String) {
    if inactiveColorHex == hex { return }
    inactiveColorHex = hex
    refreshSegmentImages()
  }

  private func rebuildSegments() {
    isUpdatingProgrammatically = true
    segmentedControl.removeAllSegments()
    for idx in 0..<titles.count {
      let img = renderSegmentImage(at: idx, selected: idx == currentIndex)
      segmentedControl.insertSegment(with: img, at: idx, animated: false)
    }
    if currentIndex >= 0 && currentIndex < titles.count {
      segmentedControl.selectedSegmentIndex = currentIndex
    } else if !titles.isEmpty {
      currentIndex = 0
      segmentedControl.selectedSegmentIndex = 0
    }
    isUpdatingProgrammatically = false
  }

  private func refreshSegmentImages() {
    let count = min(titles.count, segmentedControl.numberOfSegments)
    guard count > 0 else { return }
    for idx in 0..<count {
      let img = renderSegmentImage(at: idx, selected: idx == currentIndex)
      segmentedControl.setImage(img, forSegmentAt: idx)
    }
  }

  private func renderSegmentImage(at index: Int, selected: Bool) -> UIImage {
    let title = index < titles.count ? titles[index] : ""
    let symbolName: String
    if selected && index < selectedIcons.count && !selectedIcons[index].isEmpty {
      symbolName = selectedIcons[index]
    } else if index < icons.count && !icons[index].isEmpty {
      symbolName = icons[index]
    } else {
      symbolName = ""
    }

    let fallbackActive = isDarkMode ? UIColor(red: 0.294, green: 0.545, blue: 1.0, alpha: 1.0) : UIColor(red: 0.114, green: 0.388, blue: 0.929, alpha: 1.0)
    let fallbackInactive = isDarkMode ? UIColor(white: 0.72, alpha: 1.0) : UIColor(white: 0.38, alpha: 1.0)
    let color = selected
      ? (parseHexColor(activeColorHex) ?? fallbackActive)
      : (parseHexColor(inactiveColorHex) ?? fallbackInactive)

    let font = UIFont.systemFont(ofSize: 10.5, weight: selected ? .bold : .medium)
    let textAttrs: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
    ]
    let textSize = (title as NSString).size(withAttributes: textAttrs)

    let symConfig = UIImage.SymbolConfiguration(pointSize: 18, weight: selected ? .semibold : .regular)
    let symbolImage = symbolName.isEmpty
      ? nil
      : UIImage(systemName: symbolName, withConfiguration: symConfig)?.withTintColor(color, renderingMode: .alwaysOriginal)

    let topPad: CGFloat = 2
    let iconBoxHeight: CGFloat = 22
    let gap: CGFloat = 2
    let canvasWidth = max(60, ceil(max(symbolImage?.size.width ?? 22, textSize.width)) + 8)
    let canvasHeight = ceil(topPad + iconBoxHeight + gap + textSize.height + topPad)
    let canvasSize = CGSize(width: canvasWidth, height: canvasHeight)

    let format = UIGraphicsImageRendererFormat.default()
    format.opaque = false
    let renderer = UIGraphicsImageRenderer(size: canvasSize, format: format)
    let rendered = renderer.image { _ in
      if let sym = symbolImage {
        let symW = sym.size.width
        let symH = sym.size.height
        let symX = (canvasWidth - symW) / 2
        let symY = topPad + (iconBoxHeight - symH) / 2
        sym.draw(in: CGRect(x: symX, y: symY, width: symW, height: symH))
      }
      let textX = (canvasWidth - textSize.width) / 2
      let textY = topPad + iconBoxHeight + gap
      (title as NSString).draw(at: CGPoint(x: textX, y: textY), withAttributes: textAttrs)
    }
    return rendered.withRenderingMode(.alwaysOriginal)
  }

  private func parseHexColor(_ raw: String) -> UIColor? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("#") else { return nil }
    let hex = String(trimmed.dropFirst())
    var num: UInt64 = 0
    guard Scanner(string: hex).scanHexInt64(&num) else { return nil }
    if hex.count == 6 {
      let r = CGFloat((num & 0xFF0000) >> 16) / 255.0
      let g = CGFloat((num & 0x00FF00) >> 8) / 255.0
      let b = CGFloat(num & 0x0000FF) / 255.0
      return UIColor(red: r, green: g, blue: b, alpha: 1.0)
    }
    if hex.count == 8 {
      let r = CGFloat((num & 0xFF000000) >> 24) / 255.0
      let g = CGFloat((num & 0x00FF0000) >> 16) / 255.0
      let b = CGFloat((num & 0x0000FF00) >> 8) / 255.0
      let a = CGFloat(num & 0x000000FF) / 255.0
      return UIColor(red: r, green: g, blue: b, alpha: a)
    }
    return nil
  }

  @objc private func handleValueChanged(_ sender: UISegmentedControl) {
    if isUpdatingProgrammatically { return }
    let idx = sender.selectedSegmentIndex
    guard idx >= 0 else { return }
    currentIndex = idx
    refreshSegmentImages()
    onValueChange(["index": idx])
  }
}
