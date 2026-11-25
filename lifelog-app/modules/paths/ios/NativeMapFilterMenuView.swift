import ExpoModulesCore
import UIKit

private final class MapFilterMenuButton: UIButton {
  var onMenuWillDisplay: (() -> Void)?
  var onMenuWillEnd: (() -> Void)?

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willDisplayMenuFor configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionAnimating?
  ) {
    super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
    onMenuWillDisplay?()
  }

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willEndFor configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionAnimating?
  ) {
    super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    onMenuWillEnd?()
  }
}

// iOS 原生地图多选筛选下拉菜单按钮（UIButton + UIMenu）：
// - 放在地图外右上角液态玻璃圆钮中，纯图标无文字；
// - 点击直接在按钮下方展开原生多选菜单，包含「飞机 / 火车 / 汽车 / 轮船 / 地点」5 项；
// - iOS 16+ 使用 .keepsMenuPresented + updateVisibleMenu 原位刷新，连续勾选/取消多项不会自动收起菜单。
public final class NativeMapFilterMenuView: ExpoView {
  private static let rootMenuId = UIMenu.Identifier("lifelog.mapFilter.root")
  private static let itemPrefix = "lifelog.mapFilter.item."

  private let button = MapFilterMenuButton(type: .system)
  private var selectedKeys: Set<String> = ["flight", "train", "bus", "ship", "location"]
  private var isDarkMode: Bool = false
  private var iconColorHex: String = "#5E6675"
  private var accentColorHex: String = "#1D63ED"
  private var isMenuOpen: Bool = false

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
    button.onMenuWillDisplay = { [weak self] in
      self?.isMenuOpen = true
    }
    button.onMenuWillEnd = { [weak self] in
      guard let self = self else { return }
      self.isMenuOpen = false
      self.button.menu = self.buildRootMenu()
    }
    addSubview(button)
    refreshIcon()
    button.menu = buildRootMenu()
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
    refreshIcon()
    syncMenu()
  }

  public func setIsDark(_ isDark: Bool) {
    if isDarkMode == isDark && overrideUserInterfaceStyle != .unspecified {
      return
    }
    isDarkMode = isDark
    let style: UIUserInterfaceStyle = isDark ? .dark : .light
    overrideUserInterfaceStyle = style
    button.overrideUserInterfaceStyle = style
    refreshIcon()
  }

  public func setIconColor(_ hex: String) {
    if iconColorHex == hex { return }
    iconColorHex = hex
    refreshIcon()
  }

  public func setAccentColor(_ hex: String) {
    if accentColorHex == hex { return }
    accentColorHex = hex
    refreshIcon()
  }

  private func syncMenu() {
    if isMenuOpen, let interaction = button.contextMenuInteraction {
      if let root = button.menu {
        for element in root.children {
          if let action = element as? UIAction {
            applyState(to: action)
          }
        }
      }
      interaction.updateVisibleMenu { [weak self] visibleMenu in
        guard let self = self else { return visibleMenu }
        let nextChildren: [UIMenuElement] = visibleMenu.children.map { element in
          if let action = element as? UIAction {
            self.applyState(to: action)
            return action
          }
          return element
        }
        return visibleMenu.replacingChildren(nextChildren)
      }
    } else {
      button.menu = buildRootMenu()
    }
  }

  private func applyState(to action: UIAction) {
    let rawId = action.identifier.rawValue
    if rawId.hasPrefix(Self.itemPrefix) {
      let key = String(rawId.dropFirst(Self.itemPrefix.count))
      action.state = selectedKeys.contains(key) ? .on : .off
    }
  }

  private func refreshIcon() {
    let isFiltered = selectedKeys.count < Self.items.count
    let tintHex = isFiltered ? accentColorHex : iconColorHex
    let fallbackColor: UIColor = isFiltered
      ? (isDarkMode ? UIColor(red: 0.294, green: 0.545, blue: 1.0, alpha: 1) : UIColor(red: 0.114, green: 0.388, blue: 0.929, alpha: 1))
      : (isDarkMode ? UIColor(white: 0.78, alpha: 1) : UIColor(white: 0.35, alpha: 1))
    let tint = parseHexColor(tintHex) ?? fallbackColor

    let cfg = UIImage.SymbolConfiguration(pointSize: 15.5, weight: .medium)
    let img = UIImage(systemName: "line.3.horizontal.decrease", withConfiguration: cfg)?
      .withTintColor(tint, renderingMode: .alwaysOriginal)
    UIView.performWithoutAnimation {
      button.setImage(img, for: .normal)
      button.tintColor = tint
    }
  }

  private func buildRootMenu() -> UIMenu {
    var attrs: UIMenuElement.Attributes = []
    if #available(iOS 16.0, *) {
      attrs = [.keepsMenuPresented]
    }
    let actions = Self.items.map { item -> UIAction in
      let isOn = selectedKeys.contains(item.key)
      let sym = UIImage(systemName: item.sf)
      return UIAction(
        title: item.title,
        image: sym,
        identifier: UIAction.Identifier("\(Self.itemPrefix)\(item.key)"),
        attributes: attrs,
        state: isOn ? .on : .off
      ) { [weak self] _ in
        guard let self = self else { return }
        if self.selectedKeys.contains(item.key) {
          self.selectedKeys.remove(item.key)
        } else {
          self.selectedKeys.insert(item.key)
        }
        self.refreshIcon()
        self.syncMenu()
        self.onToggle(["key": item.key])
      }
    }
    return UIMenu(title: "", identifier: Self.rootMenuId, children: actions)
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
