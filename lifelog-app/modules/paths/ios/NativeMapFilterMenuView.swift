import ExpoModulesCore
import UIKit

// iOS 原生地图多选筛选下拉菜单按钮（UIButton + UIMenu）：
// - 放在地图外右上角液态玻璃圆钮中，纯图标无文字；
// - 点击直接在按钮下方展开原生多选菜单，包含「飞机 / 火车 / 汽车 / 轮船 / 地点」5 项；
// - iOS 16+ 使用 .keepsMenuPresented，连续勾选/取消多项不会自动收起菜单。
public final class NativeMapFilterMenuView: ExpoView {
  private let button = UIButton(type: .system)
  private var selectedKeys: Set<String> = ["flight", "train", "bus", "ship", "location"]
  private var isDarkMode: Bool = false
  private var iconColorHex: String = "#5E6675"
  private var accentColorHex: String = "#1D63ED"

  private static let items: [(key: String, title: String, sf: String)] = [
    ("flight", "飞机", "airplane"),
    ("train", "火车", "tram.fill"),
    ("bus", "汽车", "bus.fill"),
    ("ship", "轮船", "ferry.fill"),
    ("location", "地点", "mappin.and.ellipse"),
  ]

  let onToggle = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = false

    button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    button.showsMenuAsPrimaryAction = true
    button.backgroundColor = .clear
    addSubview(button)
    refreshUI()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if button.frame != bounds {
      button.frame = bounds
    }
  }

  public func setSelectedKeys(_ keys: [String]) {
    let next = Set(keys)
    if next == selectedKeys { return }
    selectedKeys = next
    refreshUI()
  }

  public func setIsDark(_ isDark: Bool) {
    if isDarkMode == isDark && overrideUserInterfaceStyle != .unspecified {
      return
    }
    isDarkMode = isDark
    let style: UIUserInterfaceStyle = isDark ? .dark : .light
    overrideUserInterfaceStyle = style
    button.overrideUserInterfaceStyle = style
    refreshUI()
  }

  public func setIconColor(_ hex: String) {
    if iconColorHex == hex { return }
    iconColorHex = hex
    refreshUI()
  }

  public func setAccentColor(_ hex: String) {
    if accentColorHex == hex { return }
    accentColorHex = hex
    refreshUI()
  }

  private func refreshUI() {
    let isFiltered = selectedKeys.count < Self.items.count
    let tintHex = isFiltered ? accentColorHex : iconColorHex
    let fallbackColor: UIColor = isFiltered
      ? (isDarkMode ? UIColor(red: 0.294, green: 0.545, blue: 1.0, alpha: 1) : UIColor(red: 0.114, green: 0.388, blue: 0.929, alpha: 1))
      : (isDarkMode ? UIColor(white: 0.78, alpha: 1) : UIColor(white: 0.35, alpha: 1))
    let tint = parseHexColor(tintHex) ?? fallbackColor

    let cfg = UIImage.SymbolConfiguration(pointSize: 15.5, weight: .medium)
    let img = UIImage(systemName: "line.3.horizontal.decrease", withConfiguration: cfg)?
      .withTintColor(tint, renderingMode: .alwaysOriginal)
    button.setImage(img, for: .normal)
    button.tintColor = tint

    let actions = Self.items.map { item -> UIAction in
      let isOn = selectedKeys.contains(item.key)
      let sym = UIImage(systemName: item.sf)
      var attrs: UIMenuElement.Attributes = []
      if #available(iOS 16.0, *) {
        attrs = [.keepsMenuPresented]
      }
      return UIAction(
        title: item.title,
        image: sym,
        attributes: attrs,
        state: isOn ? .on : .off
      ) { [weak self] _ in
        guard let self = self else { return }
        if self.selectedKeys.contains(item.key) {
          self.selectedKeys.remove(item.key)
        } else {
          self.selectedKeys.insert(item.key)
        }
        self.refreshUI()
        self.onToggle(["key": item.key])
      }
    }
    button.menu = UIMenu(title: "", children: actions)
  }

  private func parseHexColor(_ raw: String) -> UIColor? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let val = UInt64(s, radix: 16) else { return nil }
    let r = CGFloat((val >> 16) & 0xFF) / 255.0
    let g = CGFloat((val >> 8) & 0xFF) / 255.0
    let b = CGFloat(val & 0xFF) / 255.0
    return UIColor(red: r, green: g, blue: b, alpha: 1.0)
  }
}
