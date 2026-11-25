import ExpoModulesCore
import MapKit
import UIKit

// 苹果原生 MapKit（MKMapView）地图视图：
// - 原生 Metal 矢量渲染与 120Hz 缩放，彻底消除 WKWebView 地图缩放闪烁；
// - 原生 overrideUserInterfaceStyle 深浅色切换，自动跟随 App 深色/浅色主题；
// - 支持自定义水滴标点（按类型着色与层级排序）、弧线轨迹（MKPolyline）、次数徽章、
//   单击弹内容卡并实时跟踪标点屏幕坐标、双击平滑飞点放大、缩放/全览相机指令。
private struct AppleMapPayload: Decodable {
  let markers: [AppleMapPinItem]?
  let badges: [AppleMapBadgeItem]?
  let polylines: [AppleMapPolylineItem]?
  let dotBorder: String?
}

private struct AppleMapPinItem: Decodable {
  let id: String
  let lat: Double
  let lng: Double
  let color: String
  let z: Double?
}

private struct AppleMapBadgeItem: Decodable {
  let id: String
  let lat: Double
  let lng: Double
  let count: Int
  let color: String
}

private struct AppleMapPolylineItem: Decodable {
  let id: String
  let coords: [[Double]]
  let color: String
  let weight: Double?
  let opacity: Double?
}

private struct AppleMapCommand: Decodable {
  let seq: Int
  let type: String
  let lat: Double?
  let lng: Double?
  let spanDelta: Double?
  let coords: [[Double]]?
  let animated: Bool?
}

private final class ApplePinAnnotation: NSObject, MKAnnotation {
  @objc dynamic var coordinate: CLLocationCoordinate2D
  let pinId: String
  let colorHex: String
  let zValue: Double

  init(pinId: String, coordinate: CLLocationCoordinate2D, colorHex: String, zValue: Double) {
    self.pinId = pinId
    self.coordinate = coordinate
    self.colorHex = colorHex
    self.zValue = zValue
    super.init()
  }
}

private final class AppleBadgeAnnotation: NSObject, MKAnnotation {
  @objc dynamic var coordinate: CLLocationCoordinate2D
  let badgeId: String
  let count: Int
  let colorHex: String

  init(badgeId: String, coordinate: CLLocationCoordinate2D, count: Int, colorHex: String) {
    self.badgeId = badgeId
    self.coordinate = coordinate
    self.count = count
    self.colorHex = colorHex
    super.init()
  }
}

private final class StyledMapPolyline: MKPolyline {
  var colorHex: String = "#2F7BF6"
  var lineWidthVal: CGFloat = 3.0
  var alphaVal: CGFloat = 0.85
}

public final class NativeAppleMapView: ExpoView, MKMapViewDelegate, UIGestureRecognizerDelegate {
  private let mapView = MKMapView(frame: .zero)
  private var isDarkMode: Bool = false
  private var lastDataJson: String = ""
  private var lastCommandSeq: Int = 0
  private var dotBorderHex: String = "#FFFFFF"

  private var pinAnnotations: [ApplePinAnnotation] = []
  private var badgeAnnotations: [AppleBadgeAnnotation] = []
  private var lineOverlays: [StyledMapPolyline] = []

  private var pinImageCache: [String: UIImage] = [:]
  private var badgeImageCache: [String: UIImage] = [:]

  private var selectedPinId: String?
  private var selectedPinCoord: CLLocationCoordinate2D?
  private var lastTapPinId: String?
  private var lastTapTime: TimeInterval = 0

  let onPinPress = EventDispatcher()
  let onMapPress = EventDispatcher()
  let onSelectedPinMove = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true

    mapView.delegate = self
    mapView.mapType = .standard
    mapView.isRotateEnabled = false
    mapView.isPitchEnabled = false
    mapView.showsCompass = false
    mapView.showsScale = false
    mapView.pointOfInterestFilter = .includingAll
    mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    // 默认先落在中国全览视角，数据进来后再自动 fitAll
    let initialRegion = MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 34.0, longitude: 108.0),
      span: MKCoordinateSpan(latitudeDelta: 32.0, longitudeDelta: 38.0)
    )
    mapView.setRegion(initialRegion, animated: false)

    let blankTap = UITapGestureRecognizer(target: self, action: #selector(handleMapBlankTap(_:)))
    blankTap.cancelsTouchesInView = false
    blankTap.delegate = self
    mapView.addGestureRecognizer(blankTap)

    addSubview(mapView)
    applyTheme()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if mapView.frame != bounds {
      mapView.frame = bounds
      emitSelectedPinPositionIfNeeded()
    }
  }

  public func setIsDark(_ isDark: Bool) {
    if isDarkMode == isDark && mapView.overrideUserInterfaceStyle != .unspecified {
      return
    }
    isDarkMode = isDark
    applyTheme()
  }

  private func applyTheme() {
    let style: UIUserInterfaceStyle = isDarkMode ? .dark : .light
    overrideUserInterfaceStyle = style
    mapView.overrideUserInterfaceStyle = style
    let bg = isDarkMode
      ? UIColor(red: 11.0 / 255.0, green: 13.0 / 255.0, blue: 17.0 / 255.0, alpha: 1.0)
      : UIColor(red: 244.0 / 255.0, green: 246.0 / 255.0, blue: 249.0 / 255.0, alpha: 1.0)
    backgroundColor = bg
    mapView.backgroundColor = bg
  }

  public func setDataJson(_ json: String) {
    if json == lastDataJson { return }
    lastDataJson = json
    guard let data = json.data(using: .utf8),
          let payload = try? JSONDecoder().decode(AppleMapPayload.self, from: data) else {
      return
    }

    let nextBorder = (payload.dotBorder?.isEmpty == false) ? payload.dotBorder! : (isDarkMode ? "#161920" : "#FFFFFF")
    if nextBorder != dotBorderHex {
      dotBorderHex = nextBorder
      pinImageCache.removeAll()
      badgeImageCache.removeAll()
    }

    if !pinAnnotations.isEmpty {
      mapView.removeAnnotations(pinAnnotations)
      pinAnnotations.removeAll()
    }
    if !badgeAnnotations.isEmpty {
      mapView.removeAnnotations(badgeAnnotations)
      badgeAnnotations.removeAll()
    }
    if !lineOverlays.isEmpty {
      mapView.removeOverlays(lineOverlays)
      lineOverlays.removeAll()
    }

    var newOverlays: [StyledMapPolyline] = []
    for seg in payload.polylines ?? [] {
      var coords: [CLLocationCoordinate2D] = []
      coords.reserveCapacity(seg.coords.count)
      for pt in seg.coords {
        guard pt.count >= 2 else { continue }
        let lat = pt[0], lng = pt[1]
        if lat.isFinite && lng.isFinite && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 {
          coords.append(CLLocationCoordinate2D(latitude: lat, longitude: lng))
        }
      }
      guard coords.count >= 2 else { continue }
      let poly = StyledMapPolyline(coordinates: &coords, count: coords.count)
      poly.colorHex = seg.color
      poly.lineWidthVal = CGFloat(seg.weight ?? 3.0)
      poly.alphaVal = CGFloat(seg.opacity ?? 0.85)
      newOverlays.append(poly)
    }
    lineOverlays = newOverlays
    if !newOverlays.isEmpty {
      mapView.addOverlays(newOverlays, level: .aboveRoads)
    }

    var newBadges: [AppleBadgeAnnotation] = []
    for b in payload.badges ?? [] {
      guard b.lat.isFinite && b.lng.isFinite else { continue }
      let coord = CLLocationCoordinate2D(latitude: b.lat, longitude: b.lng)
      guard CLLocationCoordinate2DIsValid(coord) else { continue }
      newBadges.append(AppleBadgeAnnotation(badgeId: b.id, coordinate: coord, count: b.count, colorHex: b.color))
    }
    badgeAnnotations = newBadges
    if !newBadges.isEmpty {
      mapView.addAnnotations(newBadges)
    }

    var newPins: [ApplePinAnnotation] = []
    for p in payload.markers ?? [] {
      guard p.lat.isFinite && p.lng.isFinite else { continue }
      let coord = CLLocationCoordinate2D(latitude: p.lat, longitude: p.lng)
      guard CLLocationCoordinate2DIsValid(coord) else { continue }
      newPins.append(ApplePinAnnotation(pinId: p.id, coordinate: coord, colorHex: p.color, zValue: p.z ?? 100))
    }
    pinAnnotations = newPins
    if !newPins.isEmpty {
      mapView.addAnnotations(newPins)
    }

    if let selId = selectedPinId {
      if let found = newPins.first(where: { $0.pinId == selId }) {
        selectedPinCoord = found.coordinate
        emitSelectedPinPositionIfNeeded()
      } else {
        selectedPinId = nil
        selectedPinCoord = nil
      }
    }
  }

  public func setCommandJson(_ json: String) {
    guard !json.isEmpty,
          let data = json.data(using: .utf8),
          let cmd = try? JSONDecoder().decode(AppleMapCommand.self, from: data) else {
      return
    }
    if cmd.seq <= lastCommandSeq { return }
    lastCommandSeq = cmd.seq
    let animated = cmd.animated ?? true

    switch cmd.type {
    case "zoomIn":
      var region = mapView.region
      region.span.latitudeDelta = max(0.002, region.span.latitudeDelta * 0.5)
      region.span.longitudeDelta = max(0.002, region.span.longitudeDelta * 0.5)
      mapView.setRegion(region, animated: animated)

    case "zoomOut":
      var region = mapView.region
      region.span.latitudeDelta = min(110.0, region.span.latitudeDelta * 2.0)
      region.span.longitudeDelta = min(140.0, region.span.longitudeDelta * 2.0)
      mapView.setRegion(region, animated: animated)

    case "flyTo":
      guard let lat = cmd.lat, let lng = cmd.lng, lat.isFinite, lng.isFinite else { return }
      let center = CLLocationCoordinate2D(latitude: lat, longitude: lng)
      guard CLLocationCoordinate2DIsValid(center) else { return }
      let delta = max(0.006, min(60.0, cmd.spanDelta ?? 0.12))
      let region = MKCoordinateRegion(center: center, span: MKCoordinateSpan(latitudeDelta: delta, longitudeDelta: delta))
      mapView.setRegion(region, animated: animated)

    case "fitAll":
      let coords = (cmd.coords ?? []).compactMap { pair -> CLLocationCoordinate2D? in
        guard pair.count >= 2, pair[0].isFinite, pair[1].isFinite else { return nil }
        let c = CLLocationCoordinate2D(latitude: pair[0], longitude: pair[1])
        return CLLocationCoordinate2DIsValid(c) ? c : nil
      }
      fitCoordinates(coords, animated: animated)

    case "clearSelection":
      selectedPinId = nil
      selectedPinCoord = nil

    default:
      break
    }
  }

  private func fitCoordinates(_ coords: [CLLocationCoordinate2D], animated: Bool) {
    guard !coords.isEmpty else { return }
    if coords.count == 1 {
      let region = MKCoordinateRegion(
        center: coords[0],
        span: MKCoordinateSpan(latitudeDelta: 0.16, longitudeDelta: 0.16)
      )
      mapView.setRegion(region, animated: animated)
      return
    }
    var minLat = coords[0].latitude, maxLat = coords[0].latitude
    var minLng = coords[0].longitude, maxLng = coords[0].longitude
    var rect = MKMapRect.null
    for c in coords {
      minLat = min(minLat, c.latitude)
      maxLat = max(maxLat, c.latitude)
      minLng = min(minLng, c.longitude)
      maxLng = max(maxLng, c.longitude)
      let pt = MKMapPoint(c)
      rect = rect.union(MKMapRect(x: pt.x, y: pt.y, width: 0.1, height: 0.1))
    }
    if (maxLat - minLat) < 0.08 && (maxLng - minLng) < 0.08 {
      let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) * 0.5, longitude: (minLng + maxLng) * 0.5)
      let region = MKCoordinateRegion(center: center, span: MKCoordinateSpan(latitudeDelta: 0.16, longitudeDelta: 0.16))
      mapView.setRegion(region, animated: animated)
      return
    }
    let padding = UIEdgeInsets(top: 56, left: 42, bottom: 112, right: 56)
    mapView.setVisibleMapRect(rect, edgePadding: padding, animated: animated)
  }

  @objc private func handleMapBlankTap(_ gesture: UITapGestureRecognizer) {
    if gesture.state != .ended { return }
    selectedPinId = nil
    selectedPinCoord = nil
    onMapPress([:])
  }

  public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    var v = touch.view
    while let cur = v {
      if cur is MKAnnotationView {
        return false
      }
      v = cur.superview
    }
    return true
  }

  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    return true
  }

  public func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
    if let pin = annotation as? ApplePinAnnotation {
      let reuseId = "rc_apple_pin"
      let view = mapView.dequeueReusableAnnotationView(withIdentifier: reuseId)
        ?? MKAnnotationView(annotation: pin, reuseIdentifier: reuseId)
      view.annotation = pin
      view.canShowCallout = false
      view.isEnabled = true
      view.image = cachedPinImage(colorHex: pin.colorHex, borderHex: dotBorderHex)
      // 水滴尖端在图片底部居中，往上偏移约半高让尖端精准落在坐标点上
      view.centerOffset = CGPoint(x: 0, y: -13)
      view.displayPriority = .required
      view.zPriority = MKAnnotationViewZPriority(rawValue: min(1000.0, max(0.0, Float(pin.zValue))))
      return view
    }

    if let badge = annotation as? AppleBadgeAnnotation {
      let reuseId = "rc_apple_badge"
      let view = mapView.dequeueReusableAnnotationView(withIdentifier: reuseId)
        ?? MKAnnotationView(annotation: badge, reuseIdentifier: reuseId)
      view.annotation = badge
      view.canShowCallout = false
      view.isEnabled = false
      view.image = cachedBadgeImage(count: badge.count, colorHex: badge.colorHex, borderHex: dotBorderHex)
      view.centerOffset = .zero
      view.displayPriority = .defaultHigh
      view.zPriority = MKAnnotationViewZPriority(rawValue: 90.0)
      return view
    }

    return nil
  }

  public func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
    if let styled = overlay as? StyledMapPolyline {
      let renderer = MKPolylineRenderer(polyline: styled)
      renderer.strokeColor = parseHexColor(styled.colorHex) ?? UIColor.systemBlue
      renderer.lineWidth = styled.lineWidthVal
      renderer.alpha = styled.alphaVal
      renderer.lineCap = .round
      renderer.lineJoin = .round
      return renderer
    }
    return MKOverlayRenderer(overlay: overlay)
  }

  public func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
    guard let pin = view.annotation as? ApplePinAnnotation else { return }
    mapView.deselectAnnotation(pin, animated: false)

    let now = CACurrentMediaTime()
    let isDoubleTap = (lastTapPinId == pin.pinId) && (now - lastTapTime < 0.36)
    lastTapPinId = pin.pinId
    lastTapTime = isDoubleTap ? 0 : now

    selectedPinId = pin.pinId
    selectedPinCoord = pin.coordinate

    if isDoubleTap {
      let curSpan = mapView.region.span
      let targetDelta = max(0.008, min(0.14, min(curSpan.latitudeDelta, curSpan.longitudeDelta) * 0.4))
      let region = MKCoordinateRegion(
        center: pin.coordinate,
        span: MKCoordinateSpan(latitudeDelta: targetDelta, longitudeDelta: targetDelta)
      )
      mapView.setRegion(region, animated: true)
    }

    let pt = mapView.convert(pin.coordinate, toPointTo: mapView)
    onPinPress([
      "id": pin.pinId,
      "x": Double(pt.x),
      "y": Double(pt.y),
      "doubleTap": isDoubleTap,
    ])
  }

  public func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) {
    emitSelectedPinPositionIfNeeded()
  }

  private func emitSelectedPinPositionIfNeeded() {
    guard let pinId = selectedPinId, let coord = selectedPinCoord else { return }
    let pt = mapView.convert(coord, toPointTo: mapView)
    onSelectedPinMove([
      "id": pinId,
      "x": Double(pt.x),
      "y": Double(pt.y),
    ])
  }

  private func cachedPinImage(colorHex: String, borderHex: String) -> UIImage {
    let key = "\(colorHex)|\(borderHex)"
    if let img = pinImageCache[key] { return img }

    let size = CGSize(width: 26, height: 32)
    let fillColor = parseHexColor(colorHex) ?? UIColor(red: 0.93, green: 0.30, blue: 0.24, alpha: 1.0)
    let borderColor = parseHexColor(borderHex) ?? UIColor.white

    let renderer = UIGraphicsImageRenderer(size: size)
    let img = renderer.image { ctx in
      let cg = ctx.cgContext
      cg.saveGState()
      cg.setShadow(offset: CGSize(width: 0, height: 1.5), blur: 3.0, color: UIColor(white: 0, alpha: 0.28).cgColor)

      let cx: CGFloat = 13.0
      let cy: CGFloat = 11.5
      let r: CGFloat = 8.8
      let tipY: CGFloat = 28.5

      let path = UIBezierPath()
      path.move(to: CGPoint(x: cx, y: tipY))
      path.addCurve(
        to: CGPoint(x: cx - r, y: cy),
        controlPoint1: CGPoint(x: cx - 2.2, y: tipY - 5.2),
        controlPoint2: CGPoint(x: cx - r, y: cy + 5.8)
      )
      path.addArc(withCenter: CGPoint(x: cx, y: cy), radius: r, startAngle: .pi, endAngle: 0, clockwise: true)
      path.addCurve(
        to: CGPoint(x: cx, y: tipY),
        controlPoint1: CGPoint(x: cx + r, y: cy + 5.8),
        controlPoint2: CGPoint(x: cx + 2.2, y: tipY - 5.2)
      )
      path.close()

      fillColor.setFill()
      path.fill()
      borderColor.setStroke()
      path.lineWidth = 1.9
      path.lineJoinStyle = .round
      path.stroke()
      cg.restoreGState()

      let dotRect = CGRect(x: cx - 3.3, y: cy - 3.3, width: 6.6, height: 6.6)
      borderColor.setFill()
      UIBezierPath(ovalIn: dotRect).fill()
    }

    pinImageCache[key] = img
    return img
  }

  private func cachedBadgeImage(count: Int, colorHex: String, borderHex: String) -> UIImage {
    let key = "\(count)|\(colorHex)|\(borderHex)"
    if let img = badgeImageCache[key] { return img }

    let text = "×\(count)"
    let strokeColor = parseHexColor(colorHex) ?? UIColor.systemBlue
    let bgColor = parseHexColor(borderHex) ?? UIColor.white
    let font = UIFont.systemFont(ofSize: 11.0, weight: .bold)
    let attrs: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: strokeColor,
    ]
    let textSize = (text as NSString).size(withAttributes: attrs)
    let width = max(24.0, ceil(textSize.width) + 12.0)
    let height: CGFloat = 22.0
    let size = CGSize(width: width, height: height)

    let renderer = UIGraphicsImageRenderer(size: size)
    let img = renderer.image { _ in
      let rect = CGRect(x: 1.5, y: 1.5, width: width - 3.0, height: height - 3.0)
      let pill = UIBezierPath(roundedRect: rect, cornerRadius: rect.height * 0.5)
      bgColor.setFill()
      pill.fill()
      strokeColor.setStroke()
      pill.lineWidth = 2.0
      pill.stroke()

      let textRect = CGRect(
        x: (width - textSize.width) * 0.5,
        y: (height - textSize.height) * 0.5,
        width: textSize.width,
        height: textSize.height
      )
      (text as NSString).draw(in: textRect, withAttributes: attrs)
    }

    badgeImageCache[key] = img
    return img
  }

  private func parseHexColor(_ raw: String) -> UIColor? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6 || s.count == 8, let val = UInt64(s, radix: 16) else { return nil }
    if s.count == 6 {
      let r = CGFloat((val >> 16) & 0xFF) / 255.0
      let g = CGFloat((val >> 8) & 0xFF) / 255.0
      let b = CGFloat(val & 0xFF) / 255.0
      return UIColor(red: r, green: g, blue: b, alpha: 1.0)
    }
    let r = CGFloat((val >> 24) & 0xFF) / 255.0
    let g = CGFloat((val >> 16) & 0xFF) / 255.0
    let b = CGFloat((val >> 8) & 0xFF) / 255.0
    let a = CGFloat(val & 0xFF) / 255.0
    return UIColor(red: r, green: g, blue: b, alpha: a)
  }
}
