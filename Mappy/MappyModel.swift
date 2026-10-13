import CoreLocation
import MapKit
import SwiftUI

enum MappySkin: String, CaseIterable, Identifiable {
    case regular = "Regular"
    case satellite = "Satellite"
    case territory = "Territory"
    case roadPulse = "Road Pulse"
    case altitude = "Altitude"

    var id: String { rawValue }
    var icon: String {
        switch self {
        case .regular: "map.fill"
        case .satellite: "globe.americas.fill"
        case .territory: "point.topleft.down.to.point.bottomright.curvepath"
        case .roadPulse: "waveform.path"
        case .altitude: "mountain.2.fill"
        }
    }
    var isPremium: Bool { self == .altitude }
}

enum RoadPulseScope: String, CaseIterable, Identifiable {
    case everybody = "Everybody"
    case mine = "Mine"
    var id: String { rawValue }
}

enum MapOrientationMode: String {
    case north = "N"
    case pov = "P"
}

struct SearchPlace: Identifiable, Hashable {
    let id = UUID()
    let title: String
    let subtitle: String
    let completion: MKLocalSearchCompletion

    static func == (lhs: SearchPlace, rhs: SearchPlace) -> Bool {
        lhs.title == rhs.title && lhs.subtitle == rhs.subtitle
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(title)
        hasher.combine(subtitle)
    }
}

@MainActor
final class MappyModel: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate, @preconcurrency MKLocalSearchCompleterDelegate {
    let game = GameStore()
    @Published var selectedSkin: MappySkin = .regular
    @Published var roadPulseScope: RoadPulseScope = .everybody
    @Published var camera: MapCameraPosition = .region(
        MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 31.7683, longitude: 35.2137),
            span: MKCoordinateSpan(latitudeDelta: 0.09, longitudeDelta: 0.09)
        )
    )
    @Published var location: CLLocation?
    @Published var searchText = "" {
        didSet { completer.queryFragment = searchText }
    }
    @Published var suggestions: [SearchPlace] = []
    @Published var destination: MKMapItem?
    @Published var route: MKRoute?
    @Published var routes: [MKRoute] = []
    @Published var isRouting = false
    @Published var routeError: String?
    @Published var showingRecap = false
    @Published var hasStartedDrive = false
    @Published var centerRequest = 0
    @Published var navigationModeRequest = 0
    @Published var zoomRequest = 0
    @Published var zoomScale = 1.0
    @Published var mapOrientationMode: MapOrientationMode = .north
    @Published var orientationRequest = 0
    @Published var isMapCentered = false
    @Published var currentRouteStepIndex = 0
    @Published var terrainAltitude: Double?
    @Published var deviceHeading: CLLocationDirection?

    let locationManager = CLLocationManager()
    private let completer = MKLocalSearchCompleter()
    private var lastTerrainAltitudeLocation: CLLocation?
    private var lastRerouteDate: Date?
    private var rerouteInProgress = false
    private var routeRequestGeneration = 0
    private var navigationSteps: [MKRoute.Step] = []
    private var lastReliableDrivingCourse: CLLocationDirection?

    override init() {
        super.init()
        if ProcessInfo.processInfo.arguments.contains("-terrainPreview") {
            selectedSkin = .altitude
        }
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.activityType = .automotiveNavigation
        locationManager.headingFilter = 2
        completer.delegate = self
        completer.resultTypes = [.address, .pointOfInterest]
        completer.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 31.7683, longitude: 35.2137),
            span: MKCoordinateSpan(latitudeDelta: 4, longitudeDelta: 4)
        )
    }

    var altitudeText: String {
        let gpsIsUsable = (location?.verticalAccuracy ?? -1) >= 0 && abs(location?.altitude ?? 0) > 0.5
        guard let altitude = gpsIsUsable ? location?.altitude : terrainAltitude else { return "-- m" }
        return "\(Int(altitude.rounded())) m"
    }

    var destinationTitle: String { destination?.name ?? "Destination" }

    var navigationHeading: CLLocationDirection {
        if let location, location.speed >= 1.5, location.course >= 0 {
            return location.course
        }
        if hasStartedDrive, let lastReliableDrivingCourse { return lastReliableDrivingCourse }
        if let deviceHeading { return deviceHeading }
        if let course = location?.course, course >= 0 { return course }
        return 0
    }

    var currentManeuverInstruction: String {
        guard navigationSteps.indices.contains(currentRouteStepIndex) else {
            return destination == nil ? "Drive safely" : "Continue to \(destinationTitle)"
        }
        return navigationSteps[currentRouteStepIndex].instructions
    }

    var currentManeuverIcon: String {
        let instruction = currentManeuverInstruction.lowercased()
        if instruction.contains("left") { return "arrow.turn.up.left" }
        if instruction.contains("right") { return "arrow.turn.up.right" }
        if instruction.contains("u-turn") || instruction.contains("u turn") { return "arrow.uturn.down" }
        if instruction.contains("arrive") || instruction.contains("destination") { return "flag.checkered" }
        return "arrow.up"
    }

    var currentManeuverDistance: CLLocationDistance {
        guard navigationSteps.indices.contains(currentRouteStepIndex) else { return 0 }
        let step = navigationSteps[currentRouteStepIndex]
        guard let location else { return step.distance }
        return step.polyline.remainingDistance(from: location.coordinate)
    }

    var remainingTravelTime: TimeInterval {
        guard let route,
              route.distance > 0,
              let location else { return route?.expectedTravelTime ?? 0 }
        let remainingDistance = route.polyline.remainingDistance(from: location.coordinate)
        let secondsPerMetre = route.expectedTravelTime / route.distance
        return max(0, remainingDistance * secondsPerMetre)
    }

    var remainingRouteDistance: CLLocationDistance {
        guard let route else { return 0 }
        guard let location else { return route.distance }
        return max(0, route.polyline.remainingDistance(from: location.coordinate))
    }

    func requestLocation() {
        locationManager.requestWhenInUseAuthorization()
        locationManager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { locationManager.startUpdatingHeading() }
    }

    func centerOnUser() {
        guard let coordinate = location?.coordinate else { return }
        centerRequest += 1
        isMapCentered = true
        withAnimation(.easeInOut(duration: 0.35)) {
            camera = .region(MKCoordinateRegion(
                center: coordinate,
                span: MKCoordinateSpan(latitudeDelta: 0.025, longitudeDelta: 0.025)
            ))
        }
    }

    func choose(_ place: SearchPlace) async {
        searchText = ""
        suggestions = []
        routeError = nil
        let request = MKLocalSearch.Request(completion: place.completion)
        request.region = completer.region
        do {
            let response = try await MKLocalSearch(request: request).start()
            guard let item = response.mapItems.first else { return }
            destination = item
            await buildRoute(to: item)
        } catch {
            routeError = "We couldn't find that destination."
        }
    }

    func buildRoute(to item: MKMapItem) async {
        routeRequestGeneration += 1
        let requestGeneration = routeRequestGeneration
        isRouting = true
        defer {
            if requestGeneration == routeRequestGeneration { isRouting = false }
        }
        let source: MKMapItem
        if let location {
            source = MKMapItem(placemark: MKPlacemark(coordinate: location.coordinate))
            source.name = "My Location"
        } else {
            source = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: 31.7683, longitude: 35.2137)))
            source.name = "Jerusalem"
        }
        let request = MKDirections.Request()
        request.source = source
        request.destination = item
        request.transportType = .automobile
        request.requestsAlternateRoutes = true
        request.departureDate = Date()
        do {
            let response = try await MKDirections(request: request).calculate()
            guard requestGeneration == routeRequestGeneration else { return }
            let rankedRoutes = response.routes.sorted { $0.expectedTravelTime < $1.expectedTravelTime }
            guard let best = rankedRoutes.first else {
                routeError = "No driving route was found."
                return
            }
            routes = rankedRoutes
            route = best
            if hasStartedDrive { game.updatePaintRoute(best.polyline) }
            prepareNavigationSteps(for: best)
            let rect = best.polyline.boundingMapRect.insetBy(dx: -best.polyline.boundingMapRect.width * 0.16,
                                                              dy: -best.polyline.boundingMapRect.height * 0.16)
            withAnimation { camera = .rect(rect) }
        } catch {
            guard requestGeneration == routeRequestGeneration else { return }
            routeError = "Routing is unavailable right now."
        }
    }

    func selectRoute(_ selectedRoute: MKRoute) {
        route = selectedRoute
        if hasStartedDrive { game.updatePaintRoute(selectedRoute.polyline) }
        prepareNavigationSteps(for: selectedRoute)
        let bounds = selectedRoute.polyline.boundingMapRect
        let rect = bounds.insetBy(dx: -bounds.width * 0.16, dy: -bounds.height * 0.16)
        withAnimation { camera = .rect(rect) }
    }

    func startDrive() {
        lastReliableDrivingCourse = (location?.speed ?? -1) >= 1.5 && (location?.course ?? -1) >= 0
            ? location?.course : deviceHeading
        game.start(at: location, route: route?.polyline)
        mapOrientationMode = .pov
        isMapCentered = true
        hasStartedDrive = true
        navigationModeRequest += 1
    }

    func finishDrive() {
        let completedTrip = game.finish()
        lastReliableDrivingCourse = nil
        hasStartedDrive = false
        clearRoute()
        navigationModeRequest += 1
        if completedTrip != nil {
            showingRecap = true
        } else {
            routeError = "Drive at least 50 metres to earn XP and claim territory."
        }
    }

    func cancelDrive() {
        game.cancel()
        lastReliableDrivingCourse = nil
        hasStartedDrive = false
        clearRoute()
        navigationModeRequest += 1
    }

    func clearRoute() {
        routeRequestGeneration += 1
        isRouting = false
        destination = nil
        route = nil
        routes = []
        navigationSteps = []
        currentRouteStepIndex = 0
    }

    func zoomIn() {
        zoomScale = 0.55
        zoomRequest += 1
    }

    func zoomOut() {
        zoomScale = 1.8
        zoomRequest += 1
    }

    func centerOrToggleOrientation() {
        if hasStartedDrive {
            mapOrientationMode = .pov
            isMapCentered = true
            orientationRequest += 1
            return
        }
        if isMapCentered {
            mapOrientationMode = mapOrientationMode == .north ? .pov : .north
        }
        isMapCentered = true
        orientationRequest += 1
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse {
            manager.startUpdatingLocation()
            if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard newHeading.headingAccuracy >= 0 else { return }
        deviceHeading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        if hasStartedDrive, lastReliableDrivingCourse == nil {
            lastReliableDrivingCourse = deviceHeading
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        let wasMissing = location == nil
        location = latest
        if hasStartedDrive, latest.speed >= 1.5, latest.course >= 0 {
            lastReliableDrivingCourse = latest.course
        }
        game.record(latest)
        if hasStartedDrive {
            advanceNavigationStep(from: latest)
            Task { await rerouteIfNeeded(from: latest) }
        }
        if lastTerrainAltitudeLocation?.distance(from: latest) ?? .greatestFiniteMagnitude > 100 {
            lastTerrainAltitudeLocation = latest
            Task { await loadTerrainAltitude(at: latest.coordinate) }
        }
        completer.region = MKCoordinateRegion(
            center: latest.coordinate,
            span: MKCoordinateSpan(latitudeDelta: 2.5, longitudeDelta: 2.5)
        )
        if wasMissing { centerOnUser() }
    }

    private func rerouteIfNeeded(from latest: CLLocation) async {
        guard !rerouteInProgress,
              let route,
              let destination,
              latest.horizontalAccuracy >= 0,
              latest.horizontalAccuracy <= 50,
              route.polyline.distance(to: latest.coordinate) > 90,
              lastRerouteDate.map({ Date().timeIntervalSince($0) > 20 }) ?? true else { return }

        rerouteInProgress = true
        lastRerouteDate = Date()
        await buildRoute(to: destination)
        rerouteInProgress = false
    }

    private func prepareNavigationSteps(for route: MKRoute) {
        navigationSteps = route.steps.filter { !$0.instructions.isEmpty && $0.distance > 0 }
        currentRouteStepIndex = 0
        if let location { advanceNavigationStep(from: location) }
    }

    private func advanceNavigationStep(from location: CLLocation) {
        guard navigationSteps.indices.contains(currentRouteStepIndex),
              let end = navigationSteps[currentRouteStepIndex].polyline.endCoordinate else { return }
        let endLocation = CLLocation(latitude: end.latitude, longitude: end.longitude)
        if location.distance(from: endLocation) <= 35,
           currentRouteStepIndex < navigationSteps.count - 1 {
            currentRouteStepIndex += 1
        }
    }

    private func loadTerrainAltitude(at coordinate: CLLocationCoordinate2D) async {
        var components = URLComponents(string: "https://api.open-meteo.com/v1/elevation")!
        components.queryItems = [
            URLQueryItem(name: "latitude", value: String(format: "%.6f", coordinate.latitude)),
            URLQueryItem(name: "longitude", value: String(format: "%.6f", coordinate.longitude))
        ]
        guard let url = components.url else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            terrainAltitude = try JSONDecoder().decode(TerrainAltitudeResponse.self, from: data).elevation.first
        } catch { }
    }

    func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        suggestions = Array(completer.results.prefix(7)).map {
            SearchPlace(title: $0.title, subtitle: $0.subtitle, completion: $0)
        }
    }

    func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        suggestions = []
    }
}

private extension MKPolyline {
    var endCoordinate: CLLocationCoordinate2D? {
        guard pointCount > 0 else { return nil }
        return points()[pointCount - 1].coordinate
    }

    func distance(to coordinate: CLLocationCoordinate2D) -> CLLocationDistance {
        guard pointCount > 0 else { return .greatestFiniteMagnitude }
        let target = MKMapPoint(coordinate)
        let routePoints = points()
        guard pointCount > 1 else { return target.distance(to: routePoints[0]) }

        var minimum = CLLocationDistance.greatestFiniteMagnitude
        for index in 0..<(pointCount - 1) {
            let start = routePoints[index]
            let end = routePoints[index + 1]
            let dx = end.x - start.x
            let dy = end.y - start.y
            let lengthSquared = dx * dx + dy * dy
            let fraction: Double
            if lengthSquared == 0 {
                fraction = 0
            } else {
                fraction = max(0, min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared))
            }
            let nearest = MKMapPoint(x: start.x + fraction * dx, y: start.y + fraction * dy)
            minimum = min(minimum, target.distance(to: nearest))
        }
        return minimum
    }

    func remainingDistance(from coordinate: CLLocationCoordinate2D) -> CLLocationDistance {
        guard pointCount > 1 else { return 0 }
        let target = MKMapPoint(coordinate)
        let routePoints = points()

        var totalDistance: CLLocationDistance = 0
        for index in 0..<(pointCount - 1) {
            totalDistance += routePoints[index].distance(to: routePoints[index + 1])
        }

        var closestDistance = CLLocationDistance.greatestFiniteMagnitude
        var closestProgress: CLLocationDistance = 0
        var traversedDistance: CLLocationDistance = 0

        for index in 0..<(pointCount - 1) {
            let start = routePoints[index]
            let end = routePoints[index + 1]
            let dx = end.x - start.x
            let dy = end.y - start.y
            let lengthSquared = dx * dx + dy * dy
            let fraction: Double
            if lengthSquared == 0 {
                fraction = 0
            } else {
                fraction = max(0, min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared))
            }
            let nearest = MKMapPoint(x: start.x + fraction * dx, y: start.y + fraction * dy)
            let distanceFromRoute = target.distance(to: nearest)
            let segmentDistance = start.distance(to: end)
            if distanceFromRoute < closestDistance {
                closestDistance = distanceFromRoute
                closestProgress = traversedDistance + segmentDistance * fraction
            }
            traversedDistance += segmentDistance
        }

        return max(0, totalDistance - closestProgress)
    }
}

private struct TerrainAltitudeResponse: Decodable {
    let elevation: [Double]
}
