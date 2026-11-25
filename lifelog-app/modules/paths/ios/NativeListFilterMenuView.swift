import ExpoModulesCore
import UIKit

// iOS 原生主页列表二级多选筛选下拉菜单（UIButton + 嵌套 UIMenu）：
// - 一级菜单：旅票（子菜单）、地点（直接勾选）、娱乐与阅读（子菜单）、随笔（子菜单）+ 重置筛选；
// - 二级子菜单：包含「全选该大类」与具体子类多选（iOS 16+ 使用 .keepsMenuPresented 支持连续多选不收起）；
// - 放在搜索栏右侧液态玻璃圆钮中，直接在按钮正下方展开。
public final class NativeListFilterMenuView: ExpoView {
  private let button = UIButton(type: .system)
  private var selectedKeys: Set<String> = []
  private var isDarkMode: Bool = false
  private var iconColorHex: String = "#5E6675"
  private var accentColorHex: String = "#1D63ED"

  private static let ticketItems: [(key: String, title: String, sf: String)] = [
    ("flight", "机票", "airplane"),
    ("train", "火车票", "tram.fill"),
    ("bus", "汽车票", "bus.fill"),
    ("ship", "轮船", "ferry.fill"),
  ]

  private static let mediaItems: [(key: String, title: String, sf: String)] = [
    ("movie", "电影", "film"),
    ("tv", "剧集", "tv"),
    ("anime", "动漫", "sparkles"),
    ("game", "游戏", "gamecontroller.fill"),
    ("book", "书籍", "book.fill"),
  ]

  private static let noteItems: [(key: String, title: String, sf: String)] = [
    ("diary", "日记", "book.closed.fill"),
    ("memo", "事迹", "note.text"),
  ]

  let onSelectionChange = EventDispatcher()

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

  private func keepPresentedAttrs() -> UIMenuElement.Attributes {
    if #available(iOS 16.0, *) {
      return [.keepsMenuPresented]
    }
    return []
  }

  private func emitAndRefresh() {
    refreshUI()
    onSelectionChange(["keys": Array(selectedKeys)])
  }

  private func buildGroupSubmenu(
    title: String,
    allTitle: String,
    sf: String,
    items: [(key: String, title: String, sf: String)]
  ) -> UIMenu {
    let allKeys = items.map { $0.key }
    let activeCount = allKeys.filter { selectedKeys.contains($0) }.count
    let allSelected = activeCount == allKeys.count
    let attrs = keepPresentedAttrs()

    let toggleAll = UIAction(
      title: allTitle,
      attributes: attrs,
      state: allSelected ? .on : .off
    ) { [weak self] _ in
      guard let self = self else { return }
      if allSelected {
        for k in allKeys { self.selectedKeys.remove(k) }
      } else {
        for k in allKeys { self.selectedKeys.insert(k) }
      }
      self.emitAndRefresh()
    }

    let childActions = items.map { item -> UIAction in
      let isOn = selectedKeys.contains(item.key)
      return UIAction(
        title: item.title,
        image: UIImage(systemName: item.sf),
        attributes: attrs,
        state: isOn ? .on : .off
      ) { [weak self] _ in
        guard let self = self else { return }
        if self.selectedKeys.contains(item.key) {
          self.selectedKeys.remove(item.key)
        } else {
          self.selectedKeys.insert(item.key)
        }
        self.emitAndRefresh()
      }
    }

    let subSection = UIMenu(title: "", options: .displayInline, children: childActions)
    let menu = UIMenu(
      title: title,
      image: UIImage(systemName: sf),
      children: [toggleAll, subSection]
    )
    if activeCount > 0 {
      menu.subtitle = "已选 \(activeCount) 项"
    }
    return menu
  }

  private func refreshUI() {
    let hasFilter = !selectedKeys.isEmpty
    let tintHex = hasFilter ? accentColorHex : iconColorHex
    let fallbackColor: UIColor = hasFilter
      ? (isDarkMode ? UIColor(red: 0.294, green: 0.545, blue: 1.0, alpha: 1) : UIColor(red: 0.114, green: 0.388, blue: 0.929, alpha: 1))
      : (isDarkMode ? UIColor(white: 0.78, alpha: 1) : UIColor(white: 0.35, alpha: 1))
    let tint = parseHexColor(tintHex) ?? fallbackColor

    let cfg = UIImage.SymbolConfiguration(pointSize: 15.5, weight: .medium)
    let img = UIImage(systemName: "line.3.horizontal.decrease", withConfiguration: cfg)?
      .withTintColor(tint, renderingMode: .alwaysOriginal)
    button.setImage(img, for: .normal)
    button.tintColor = tint

    let ticketMenu = buildGroupSubmenu(
      title: "旅票",
      allTitle: "全部旅票",
      sf: "airplane",
      items: Self.ticketItems
    )

    let locOn = selectedKeys.contains("location")
    let locationAction = UIAction(
      title: "地点",
      image: UIImage(systemName: "mappin.and.ellipse"),
      attributes: keepPresentedAttrs(),
      state: locOn ? .on : .off
    ) { [weak self] _ in
      guard let self = self else { return }
      if self.selectedKeys.contains("location") {
        self.selectedKeys.remove("location")
      } else {
        self.selectedKeys.insert("location")
      }
      self.emitAndRefresh()
    }

    let mediaMenu = buildGroupSubmenu(
      title: "娱乐与阅读",
      allTitle: "全部娱乐与阅读",
      sf: "film",
      items: Self.mediaItems
    )

    let noteMenu = buildGroupSubmenu(
      title: "随笔",
      allTitle: "全部随笔",
      sf: "book.closed.fill",
      items: Self.noteItems
    )

    var topElements: [UIMenuElement] = [ticketMenu, locationAction, mediaMenu, noteMenu]
    if hasFilter {
      let resetAction = UIAction(
        title: "重置筛选",
        image: UIImage(systemName: "arrow.counterclockwise"),
        attributes: .destructive
      ) { [weak self] _ in
        guard let self = self else { return }
        self.selectedKeys.removeAll()
        self.emitAndRefresh()
      }
      let resetSection = UIMenu(title: "", options: .displayInline, children: [resetAction])
      topElements.append(resetSection)
    }

    button.menu = UIMenu(title: "", children: topElements)
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
