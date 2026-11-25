import ExpoModulesCore
import UIKit

// 自定义 UIButton 子类：监听系统菜单展开/收起生命周期，避免在菜单展开期间重设 button.menu 导致菜单被系统强制收起
private final class ListFilterMenuButton: UIButton {
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

// iOS 原生主页列表二级多选筛选下拉菜单（UIButton + 嵌套 UIMenu）：
// - 一级菜单：旅票（子菜单）、地点（直接勾选）、娱乐与阅读（子菜单）、随笔（子菜单）+ 重置筛选；
// - 二级子菜单：包含「全选该大类」与具体子类多选（iOS 16+ 使用 .keepsMenuPresented + updateVisibleMenu 原位刷新，
//   单次勾选/取消不会收起菜单，由用户点击空白处手动收起）；
// - 放在搜索栏右侧液态玻璃圆钮中，直接在按钮正下方展开。
public final class NativeListFilterMenuView: ExpoView {
  private struct FilterGroup {
    let key: String
    let menuId: UIMenu.Identifier
    let inlineId: UIMenu.Identifier
    let title: String
    let allTitle: String
    let sf: String
    let items: [(key: String, title: String, sf: String)]
  }

  private static let rootMenuId = UIMenu.Identifier("lifelog.listFilter.root")
  private static let resetMenuId = UIMenu.Identifier("lifelog.listFilter.resetSection")
  private static let resetActionId = UIAction.Identifier("lifelog.listFilter.reset")
  private static let allPrefix = "lifelog.listFilter.all."
  private static let itemPrefix = "lifelog.listFilter.item."

  private static let groups: [FilterGroup] = [
    FilterGroup(
      key: "ticket",
      menuId: UIMenu.Identifier("lifelog.listFilter.group.ticket"),
      inlineId: UIMenu.Identifier("lifelog.listFilter.inline.ticket"),
      title: "旅票",
      allTitle: "全部旅票",
      sf: "airplane",
      items: [
        ("flight", "机票", "airplane"),
        ("train", "火车票", "tram.fill"),
        ("bus", "汽车票", "bus.fill"),
        ("ship", "轮船", "ferry.fill"),
      ]
    ),
    FilterGroup(
      key: "media",
      menuId: UIMenu.Identifier("lifelog.listFilter.group.media"),
      inlineId: UIMenu.Identifier("lifelog.listFilter.inline.media"),
      title: "娱乐与阅读",
      allTitle: "全部娱乐与阅读",
      sf: "film",
      items: [
        ("movie", "电影", "film"),
        ("tv", "剧集", "tv"),
        ("anime", "动漫", "sparkles"),
        ("game", "游戏", "gamecontroller.fill"),
        ("book", "书籍", "book.fill"),
      ]
    ),
    FilterGroup(
      key: "note",
      menuId: UIMenu.Identifier("lifelog.listFilter.group.note"),
      inlineId: UIMenu.Identifier("lifelog.listFilter.inline.note"),
      title: "随笔",
      allTitle: "全部随笔",
      sf: "book.closed.fill",
      items: [
        ("diary", "日记", "book.closed.fill"),
        ("memo", "事迹", "note.text"),
      ]
    ),
  ]

  private static func group(for menuId: UIMenu.Identifier) -> FilterGroup? {
    return groups.first { $0.menuId == menuId }
  }

  private static func group(forKey key: String) -> FilterGroup? {
    return groups.first { $0.key == key }
  }

  private let button = ListFilterMenuButton(type: .system)
  private var selectedKeys: Set<String> = []
  private var isDarkMode: Bool = false
  private var iconColorHex: String = "#5E6675"
  private var accentColorHex: String = "#1D63ED"
  private var isMenuOpen: Bool = false

  let onSelectionChange = EventDispatcher()

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
      // 收起后再同步重建一次根菜单，确保下次打开时状态完全一致
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

  private func keepPresentedAttrs() -> UIMenuElement.Attributes {
    if #available(iOS 16.0, *) {
      return [.keepsMenuPresented]
    }
    return []
  }

  private func resetAttrs() -> UIMenuElement.Attributes {
    var attrs = keepPresentedAttrs()
    attrs.insert(.destructive)
    if selectedKeys.isEmpty {
      attrs.insert(.disabled)
    }
    return attrs
  }

  private func emitAndSync() {
    refreshIcon()
    syncMenu()
    onSelectionChange(["keys": Array(selectedKeys)])
  }

  private func syncMenu() {
    if isMenuOpen, let interaction = button.contextMenuInteraction {
      // 关键：菜单展开期间绝不重设 button.menu（否则 UIKit 会立即收起菜单/子菜单），
      // 改为先同步内存中的根菜单状态，再通过 updateVisibleMenu 原位刷新可见菜单。
      if let root = button.menu {
        applyStateInPlace(to: root)
      }
      interaction.updateVisibleMenu { [weak self] visibleMenu in
        guard let self = self else { return visibleMenu }
        return self.updatedVisibleMenu(visibleMenu)
      }
    } else {
      button.menu = buildRootMenu()
    }
  }

  private func applyState(to action: UIAction) {
    let rawId = action.identifier.rawValue
    if rawId == Self.resetActionId.rawValue {
      action.attributes = resetAttrs()
    } else if rawId.hasPrefix(Self.allPrefix) {
      let groupKey = String(rawId.dropFirst(Self.allPrefix.count))
      if let group = Self.group(forKey: groupKey) {
        let allOn = group.items.allSatisfy { selectedKeys.contains($0.key) }
        action.state = allOn ? .on : .off
      }
    } else if rawId.hasPrefix(Self.itemPrefix) {
      let key = String(rawId.dropFirst(Self.itemPrefix.count))
      action.state = selectedKeys.contains(key) ? .on : .off
    }
  }

  private func applyStateInPlace(to menu: UIMenu) {
    for element in menu.children {
      if let sub = element as? UIMenu {
        applyStateInPlace(to: sub)
        if let group = Self.group(for: sub.identifier) {
          let count = group.items.filter { selectedKeys.contains($0.key) }.count
          sub.subtitle = count > 0 ? "已选 \(count) 项" : nil
        }
      } else if let action = element as? UIAction {
        applyState(to: action)
      }
    }
  }

  private func updatedVisibleMenu(_ menu: UIMenu) -> UIMenu {
    let nextChildren: [UIMenuElement] = menu.children.map { element in
      if let sub = element as? UIMenu {
        let updatedSub = updatedVisibleMenu(sub)
        if let group = Self.group(for: updatedSub.identifier) {
          let count = group.items.filter { selectedKeys.contains($0.key) }.count
          updatedSub.subtitle = count > 0 ? "已选 \(count) 项" : nil
        }
        return updatedSub
      }
      if let action = element as? UIAction {
        applyState(to: action)
        return action
      }
      return element
    }
    let replaced = menu.replacingChildren(nextChildren)
    if let group = Self.group(for: replaced.identifier) {
      let count = group.items.filter { selectedKeys.contains($0.key) }.count
      replaced.subtitle = count > 0 ? "已选 \(count) 项" : nil
    }
    return replaced
  }

  private func refreshIcon() {
    let hasFilter = !selectedKeys.isEmpty
    let tintHex = hasFilter ? accentColorHex : iconColorHex
    let fallbackColor: UIColor = hasFilter
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

  private func buildGroupSubmenu(_ group: FilterGroup) -> UIMenu {
    let allKeys = group.items.map { $0.key }
    let activeCount = allKeys.filter { selectedKeys.contains($0) }.count
    let allSelected = activeCount == allKeys.count
    let attrs = keepPresentedAttrs()

    let toggleAll = UIAction(
      title: group.allTitle,
      identifier: UIAction.Identifier("\(Self.allPrefix)\(group.key)"),
      attributes: attrs,
      state: allSelected ? .on : .off
    ) { [weak self] _ in
      guard let self = self else { return }
      let currentlyAll = allKeys.allSatisfy { self.selectedKeys.contains($0) }
      if currentlyAll {
        for k in allKeys { self.selectedKeys.remove(k) }
      } else {
        for k in allKeys { self.selectedKeys.insert(k) }
      }
      self.emitAndSync()
    }

    let childActions = group.items.map { item -> UIAction in
      let isOn = selectedKeys.contains(item.key)
      return UIAction(
        title: item.title,
        image: UIImage(systemName: item.sf),
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
        self.emitAndSync()
      }
    }

    let subSection = UIMenu(
      title: "",
      identifier: group.inlineId,
      options: .displayInline,
      children: childActions
    )
    let menu = UIMenu(
      title: group.title,
      image: UIImage(systemName: group.sf),
      identifier: group.menuId,
      children: [toggleAll, subSection]
    )
    if activeCount > 0 {
      menu.subtitle = "已选 \(activeCount) 项"
    }
    return menu
  }

  private func buildRootMenu() -> UIMenu {
    let ticketMenu = buildGroupSubmenu(Self.groups[0])

    let locOn = selectedKeys.contains("location")
    let locationAction = UIAction(
      title: "地点",
      image: UIImage(systemName: "mappin.and.ellipse"),
      identifier: UIAction.Identifier("\(Self.itemPrefix)location"),
      attributes: keepPresentedAttrs(),
      state: locOn ? .on : .off
    ) { [weak self] _ in
      guard let self = self else { return }
      if self.selectedKeys.contains("location") {
        self.selectedKeys.remove("location")
      } else {
        self.selectedKeys.insert("location")
      }
      self.emitAndSync()
    }

    let mediaMenu = buildGroupSubmenu(Self.groups[1])
    let noteMenu = buildGroupSubmenu(Self.groups[2])

    // 始终保留重置筛选分区（无筛选项时置灰禁用），保证菜单结构稳定，切换首项时不会触发布局重排收起菜单
    let resetAction = UIAction(
      title: "重置筛选",
      image: UIImage(systemName: "arrow.counterclockwise"),
      identifier: Self.resetActionId,
      attributes: resetAttrs()
    ) { [weak self] _ in
      guard let self = self else { return }
      if self.selectedKeys.isEmpty { return }
      self.selectedKeys.removeAll()
      self.emitAndSync()
    }
    let resetSection = UIMenu(
      title: "",
      identifier: Self.resetMenuId,
      options: .displayInline,
      children: [resetAction]
    )

    return UIMenu(
      title: "",
      identifier: Self.rootMenuId,
      children: [ticketMenu, locationAction, mediaMenu, noteMenu, resetSection]
    )
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
