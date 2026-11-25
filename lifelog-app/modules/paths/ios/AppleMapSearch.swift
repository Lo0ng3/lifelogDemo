import CoreLocation
import Foundation
import MapKit

// 苹果原生 MapKit 地点搜索联想与地理编码（免密钥、国内直连高德底层 POI 库、海外走 Apple Maps）。
// 返回的坐标对中国大陆地点为 GCJ-02，由 JS 层统一转回 WGS-84 后入库。
internal final class AppleMapSearchSession: NSObject, MKLocalSearchCompleterDelegate {
  private var searchToken: Int = 0
  private var activeSearch: MKLocalSearch?
  private var completer: MKLocalSearchCompleter?
  private var completerTimeout: DispatchWorkItem?
  private var completerCompletion: (([[String: Any]]) -> Void)?

  func searchPlaces(query: String, completion: @escaping ([[String: Any]]) -> Void) {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      completion([])
      return
    }

    searchToken += 1
    let token = searchToken
    cancelAll()

    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = trimmed
    request.resultTypes = [.address, .pointOfInterest]

    let search = MKLocalSearch(request: request)
    activeSearch = search

    search.start { [weak self] response, _ in
      DispatchQueue.main.async {
        guard let self = self, self.searchToken == token else {
          completion([])
          return
        }
        if self.activeSearch === search {
          self.activeSearch = nil
        }

        var items: [[String: Any]] = []
        var seen = Set<String>()

        if let mapItems = response?.mapItems {
          for item in mapItems {
            let name = (item.name ?? item.placemark.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty { continue }
            let coord = item.placemark.coordinate
            guard CLLocationCoordinate2DIsValid(coord),
                  coord.latitude.isFinite,
                  coord.longitude.isFinite else {
              continue
            }
            let district = Self.formatDistrict(placemark: item.placemark, excludeName: name)
            let dedupeKey = "\(name)|\(district)"
            if seen.contains(dedupeKey) { continue }
            seen.insert(dedupeKey)

            items.append([
              "name": name,
              "district": district,
              "lat": coord.latitude,
              "lng": coord.longitude,
              "isPrompt": false,
            ])
            if items.count >= 8 { break }
          }
        }

        if !items.isEmpty {
          completion(items)
          return
        }

        // 局部短前缀在 MKLocalSearch 无直接命中时，退回 MKLocalSearchCompleter 提供联想词
        self.runCompleterFallback(query: trimmed, completion: completion)
      }
    }
  }

  func geocodePlace(query: String, completion: @escaping ([String: Any]?) -> Void) {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      completion(nil)
      return
    }

    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = trimmed
    request.resultTypes = [.address, .pointOfInterest]

    let search = MKLocalSearch(request: request)
    search.start { response, _ in
      if let first = response?.mapItems.first {
        let coord = first.placemark.coordinate
        if CLLocationCoordinate2DIsValid(coord) && coord.latitude.isFinite && coord.longitude.isFinite {
          completion([
            "lat": coord.latitude,
            "lng": coord.longitude,
          ])
          return
        }
      }

      let geocoder = CLGeocoder()
      geocoder.geocodeAddressString(trimmed) { placemarks, _ in
        if let coord = placemarks?.first?.location?.coordinate,
           CLLocationCoordinate2DIsValid(coord),
           coord.latitude.isFinite,
           coord.longitude.isFinite {
          completion([
            "lat": coord.latitude,
            "lng": coord.longitude,
          ])
        } else {
          completion(nil)
        }
      }
    }
  }

  private func runCompleterFallback(query: String, completion: @escaping ([[String: Any]]) -> Void) {
    let c = MKLocalSearchCompleter()
    c.delegate = self
    c.resultTypes = [.address, .pointOfInterest]
    completer = c
    completerCompletion = completion

    let timeout = DispatchWorkItem { [weak self] in
      self?.finishCompleter(with: [])
    }
    completerTimeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: timeout)
    c.queryFragment = query
  }

  private func finishCompleter(with results: [[String: Any]]) {
    completerTimeout?.cancel()
    completerTimeout = nil
    completer?.cancel()
    completer?.delegate = nil
    completer = nil
    if let cb = completerCompletion {
      completerCompletion = nil
      cb(results)
    }
  }

  private func cancelAll() {
    activeSearch?.cancel()
    activeSearch = nil
    finishCompleter(with: [])
  }

  func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
    guard completer === self.completer else { return }
    var out: [[String: Any]] = []
    var seen = Set<String>()
    for item in completer.results {
      let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
      if title.isEmpty || seen.contains(title) { continue }
      seen.insert(title)
      let subtitle = item.subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
      out.append([
        "name": title,
        "district": subtitle.isEmpty ? "联想词 · 点击继续搜索" : subtitle,
        "isPrompt": true,
      ])
      if out.count >= 8 { break }
    }
    finishCompleter(with: out)
  }

  func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
    guard completer === self.completer else { return }
    finishCompleter(with: [])
  }

  private static func formatDistrict(placemark: MKPlacemark, excludeName: String) -> String {
    let rawParts: [String?] = [
      placemark.administrativeArea,
      placemark.locality,
      placemark.subLocality,
      placemark.thoroughfare,
      placemark.subThoroughfare,
    ]
    var parts: [String] = []
    for raw in rawParts {
      guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { continue }
      if s == excludeName { continue }
      if parts.contains(s) { continue }
      parts.append(s)
    }
    if !parts.isEmpty {
      return parts.joined(separator: " ")
    }
    let fallback = (placemark.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return fallback == excludeName ? "" : fallback
  }
}
