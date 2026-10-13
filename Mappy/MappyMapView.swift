import MapKit
import SwiftUI

struct MappyMapView: UIViewRepresentable {
    @ObservedObject var model: MappyModel
    let territoryTrips: [RecordedTrip]
    let liveTerritoryPoints: [TripPoint]
    let viewportSize: CGSize

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView(frame: .zero)
        map.delegate = context.coordinator
        // Core Location lives in MappyModel; our own marker can later accept a map-matched position.
        map.showsUserLocation = false
        map.showsCompass = false
        map.pointOfInterestFilter = .includingAll
        map.setRegion(MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 31.7683, longitude: 35.2137),
            span: MKCoordinateSpan(latitudeDelta: 0.09, longitudeDelta: 0.09)
        ), animated: false)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        context.coordinator.applySkin(model.selectedSkin, to: map)
        context.coordinator.applyRoutes(model.routes, selectedRoute: model.route, destination: model.destination, to: map)
        context.coordinator.updatePositionMarker(in: map, coordinate: model.location?.coordinate)
        context.coordinator.applyTerritory(
            territoryTrips,
            livePoints: liveTerritoryPoints,
            visible: model.selectedSkin == .territory,
            to: map
        )
        context.coordinator.applyRoadPulse(
            territoryTrips,
            visible: model.selectedSkin == .roadPulse && model.roadPulseScope == .mine,
            to: map
        )
        context.coordinator.applyDriveState(
            model.hasStartedDrive,
            request: model.navigationModeRequest,
            orientation: model.mapOrientationMode,
            location: model.location,
            to: map
        )
        context.coordinator.applyZoom(
            request: model.zoomRequest,
            scale: model.zoomScale,
            followingMode: model.hasStartedDrive ? model.mapOrientationMode : nil,
            to: map
        )
        context.coordinator.applyOrientation(
            request: model.orientationRequest,
            mode: model.mapOrientationMode,
            location: model.location,
            to: map
        )
        context.coordinator.applyDrivingCamera(
            isDriving: model.hasStartedDrive,
            hasRoute: model.route != nil,
            orientation: model.mapOrientationMode,
            location: model.location,
            heading: model.navigationHeading,
            viewportSize: viewportSize,
            to: map
        )
        context.coordinator.updateUserArrow(in: map, heading: model.navigationHeading)

        if context.coordinator.lastCenterRequest != model.centerRequest {
            context.coordinator.lastCenterRequest = model.centerRequest
            if !model.hasStartedDrive, let coordinate = model.location?.coordinate {
                map.setRegion(MKCoordinateRegion(
                    center: coordinate,
                    span: MKCoordinateSpan(latitudeDelta: 0.025, longitudeDelta: 0.025)
                ), animated: true)
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate {
        private weak var model: MappyModel?
        private var terrainOverlay: TerrainTileOverlay?
        private var appliedRoutes: [MKRoute] = []
        private weak var appliedRoute: MKRoute?
        private weak var selectedPolyline: MKPolyline?
        private var appliedDestinationName: String?
        private var appliedSkin: MappySkin?
        private var appliedTerritoryTripIDs: [UUID] = []
        private var appliedLiveTerritoryPointCount = 0
        private var appliedTerritoryVisible = false
        private var appliedRoadPulseTripIDs: [UUID] = []
        private var appliedRoadPulseVisible = false
        private var appliedDriving = false
        private var lastNavigationModeRequest = 0
        private var lastZoomRequest = 0
        private var lastOrientationRequest = 0
        private var driveCameraDistance: CLLocationDistance = 620
        private var lastDrivingCoordinate: CLLocationCoordinate2D?
        private var lastDrivingCourse: CLLocationDirection?
        private var lastDrivingOrientation: MapOrientationMode?
        private var lastDrivingHadRoute: Bool?
        private var lastDrivingViewportSize: CGSize?
        private let positionAnnotation: MappyPositionAnnotation = {
            let annotation = MappyPositionAnnotation()
            annotation.title = "My location"
            return annotation
        }()
        private static let positionImage: UIImage = {
            let size = CGSize(width: 28, height: 28)
            return UIGraphicsImageRenderer(size: size).image { _ in
                let arrow = UIBezierPath()
                arrow.move(to: CGPoint(x: 14, y: 2))
                arrow.addLine(to: CGPoint(x: 25, y: 25))
                arrow.addLine(to: CGPoint(x: 14, y: 20))
                arrow.addLine(to: CGPoint(x: 3, y: 25))
                arrow.close()
                UIColor.black.withAlphaComponent(0.82).setStroke()
                arrow.lineWidth = 2.5
                arrow.lineJoinStyle = .round
                arrow.stroke()
                UIColor.mappyAccent.setFill()
                arrow.fill()
            }
        }()
        var lastCenterRequest = 0

        init(model: MappyModel) {
            self.model = model
        }

        func applyDriveState(
            _ isDriving: Bool,
            request: Int,
            orientation: MapOrientationMode,
            location: CLLocation?,
            to map: MKMapView
        ) {
            guard appliedDriving != isDriving || lastNavigationModeRequest != request else { return }
            appliedDriving = isDriving
            lastNavigationModeRequest = request

            if isDriving {
                driveCameraDistance = 620
                lastDrivingCoordinate = nil
                lastDrivingCourse = nil
                lastDrivingOrientation = nil
                lastDrivingHadRoute = nil
                lastDrivingViewportSize = nil
                map.setUserTrackingMode(.none, animated: false)
            } else {
                map.setUserTrackingMode(.none, animated: true)
                lastDrivingCoordinate = nil
                lastDrivingCourse = nil
                lastDrivingOrientation = nil
                lastDrivingHadRoute = nil
                lastDrivingViewportSize = nil
            }
        }

        func applyDrivingCamera(
            isDriving: Bool,
            hasRoute: Bool,
            orientation: MapOrientationMode,
            location: CLLocation?,
            heading: CLLocationDirection,
            viewportSize: CGSize,
            to map: MKMapView
        ) {
            guard isDriving, let location else { return }

            let course = heading
            let moved: Bool
            if let previous = lastDrivingCoordinate {
                moved = MKMapPoint(previous).distance(to: MKMapPoint(location.coordinate)) >= 2
            } else {
                moved = true
            }
            let courseChanged = lastDrivingCourse.map { abs(shortestHeadingDelta(from: $0, to: course)) >= 2 } ?? true
            let orientationChanged = lastDrivingOrientation != orientation
            let routeModeChanged = lastDrivingHadRoute != hasRoute
            let viewportChanged = lastDrivingViewportSize.map {
                abs($0.width - viewportSize.width) > 1 || abs($0.height - viewportSize.height) > 1
            } ?? true
            guard moved || courseChanged || orientationChanged || routeModeChanged || viewportChanged else { return }

            let firstCamera = lastDrivingCoordinate == nil
            lastDrivingCoordinate = location.coordinate
            lastDrivingCourse = course
            lastDrivingOrientation = orientation
            lastDrivingHadRoute = hasRoute
            lastDrivingViewportSize = viewportSize

            let heading = orientation == .pov ? course : 0
            let isLandscape = viewportSize.width > viewportSize.height
            // Quick Start is a flat, course-up map; only routed guidance uses a tilted camera.
            let pitch: CGFloat = hasRoute && orientation == .pov ? (isLandscape ? 28 : 43) : 0
            // Keep a parked Free Drive marker clear of the bottom card; look ahead only once moving.
            let lookAhead: CLLocationDistance = hasRoute
                ? (isLandscape ? 80 : 105)
                : (location.speed >= 1.5 ? 35 : 0)
            let focus = orientation == .pov
                ? coordinate(from: location.coordinate, distance: lookAhead, bearing: heading)
                : location.coordinate
            let camera = MKMapCamera(
                lookingAtCenter: focus,
                fromDistance: driveCameraDistance * (isLandscape ? 1.15 : 1),
                pitch: pitch,
                heading: heading
            )
            map.setCamera(camera, animated: firstCamera || (moved && !viewportChanged))
        }

        func updateUserArrow(in map: MKMapView, heading: CLLocationDirection) {
            guard let arrow = map.view(for: positionAnnotation) else { return }
            let rotation = shortestHeadingDelta(from: map.camera.heading, to: heading) * .pi / 180
            arrow.transform = CGAffineTransform(rotationAngle: rotation)
        }

        func updatePositionMarker(in map: MKMapView, coordinate: CLLocationCoordinate2D?) {
            guard let coordinate else {
                if map.annotations.contains(where: { $0 === positionAnnotation }) {
                    map.removeAnnotation(positionAnnotation)
                }
                return
            }
            if !map.annotations.contains(where: { $0 === positionAnnotation }) {
                positionAnnotation.coordinate = coordinate
                map.addAnnotation(positionAnnotation)
            } else {
                positionAnnotation.coordinate = coordinate
            }
        }

        func applyOrientation(
            request: Int,
            mode: MapOrientationMode,
            location: CLLocation?,
            to map: MKMapView
        ) {
            guard lastOrientationRequest != request else { return }
            lastOrientationRequest = request
            if appliedDriving {
                lastDrivingOrientation = nil
                return
            }
            if let coordinate = location?.coordinate {
                map.setCenter(coordinate, animated: true)
            }
            if mode == .north {
                let camera = map.camera.copy() as! MKMapCamera
                camera.heading = 0
                map.setCamera(camera, animated: true)
                map.setUserTrackingMode(.follow, animated: true)
            } else {
                map.setUserTrackingMode(.followWithHeading, animated: true)
            }
        }

        func applyZoom(request: Int, scale: Double, followingMode: MapOrientationMode?, to map: MKMapView) {
            guard lastZoomRequest != request else { return }
            lastZoomRequest = request
            if followingMode != nil {
                driveCameraDistance = min(4_000, max(180, driveCameraDistance * scale))
                lastDrivingCoordinate = nil
                return
            }
            let current = map.region
            let latitudeDelta = min(90, max(0.0008, current.span.latitudeDelta * scale))
            let longitudeDelta = min(180, max(0.0008, current.span.longitudeDelta * scale))
            map.setRegion(
                MKCoordinateRegion(
                    center: current.center,
                    span: MKCoordinateSpan(latitudeDelta: latitudeDelta, longitudeDelta: longitudeDelta)
                ),
                animated: true
            )
        }

        private func shortestHeadingDelta(from: CLLocationDirection, to: CLLocationDirection) -> CLLocationDirection {
            (to - from + 540).truncatingRemainder(dividingBy: 360) - 180
        }

        private func coordinate(
            from start: CLLocationCoordinate2D,
            distance: CLLocationDistance,
            bearing: CLLocationDirection
        ) -> CLLocationCoordinate2D {
            let earthRadius = 6_371_000.0
            let angularDistance = distance / earthRadius
            let bearingRadians = bearing * .pi / 180
            let latitude = start.latitude * .pi / 180
            let longitude = start.longitude * .pi / 180
            let destinationLatitude = asin(
                sin(latitude) * cos(angularDistance)
                    + cos(latitude) * sin(angularDistance) * cos(bearingRadians)
            )
            let destinationLongitude = longitude + atan2(
                sin(bearingRadians) * sin(angularDistance) * cos(latitude),
                cos(angularDistance) - sin(latitude) * sin(destinationLatitude)
            )
            return CLLocationCoordinate2D(
                latitude: destinationLatitude * 180 / .pi,
                longitude: destinationLongitude * 180 / .pi
            )
        }

        func applySkin(_ skin: MappySkin, to map: MKMapView) {
            guard appliedSkin != skin else { return }
            appliedSkin = skin
            if let terrainOverlay {
                map.removeOverlay(terrainOverlay)
                self.terrainOverlay = nil
            }
            switch skin {
            case .regular:
                let configuration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
                configuration.showsTraffic = true
                map.preferredConfiguration = configuration
                map.pointOfInterestFilter = .includingAll
            case .satellite:
                let configuration = MKHybridMapConfiguration(elevationStyle: .flat)
                configuration.showsTraffic = true
                map.preferredConfiguration = configuration
            case .territory:
                let configuration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
                configuration.showsTraffic = true
                map.preferredConfiguration = configuration
                map.pointOfInterestFilter = .excludingAll
            case .roadPulse:
                let configuration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
                configuration.showsTraffic = false
                map.preferredConfiguration = configuration
                map.pointOfInterestFilter = .excludingAll
            case .altitude:
                let configuration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
                configuration.showsTraffic = true
                map.preferredConfiguration = configuration
                map.pointOfInterestFilter = .excludingAll
                let overlay = TerrainTileOverlay()
                terrainOverlay = overlay
                map.addOverlay(overlay, level: .aboveRoads)
            }
        }

        func applyRoadPulse(_ trips: [RecordedTrip], visible: Bool, to map: MKMapView) {
            let tripIDs = trips.map(\.id)
            guard appliedRoadPulseTripIDs != tripIDs || appliedRoadPulseVisible != visible else { return }
            let previous = map.overlays.filter { (($0 as? MKShape)?.title ?? "").hasPrefix("mappy-road-pulse") }
            map.removeOverlays(previous)
            appliedRoadPulseTripIDs = tripIDs
            appliedRoadPulseVisible = visible
            guard visible else { return }
            // Every recorded traversal adds a translucent road-width stroke. Repeated use
            // darkens the same corridor; this is frequency, never competitive ownership.
            for trip in trips.reversed() {
                let coordinates = trip.territoryPaintPoints.map {
                    CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
                }
                guard coordinates.count > 1 else { continue }
                let line = MKPolyline(coordinates: coordinates, count: coordinates.count)
                line.title = "mappy-road-pulse"
                map.addOverlay(line, level: .aboveRoads)
            }
        }

        func applyTerritory(_ trips: [RecordedTrip], livePoints: [TripPoint], visible: Bool, to map: MKMapView) {
            let tripIDs = trips.map(\.id)
            guard appliedTerritoryTripIDs != tripIDs
                    || appliedLiveTerritoryPointCount != livePoints.count
                    || appliedTerritoryVisible != visible else { return }
            let territoryOverlays = map.overlays.filter {
                (($0 as? MKShape)?.title ?? "").hasPrefix("mappy-territory")
            }
            map.removeOverlays(territoryOverlays)
            appliedTerritoryTripIDs = tripIDs
            appliedLiveTerritoryPointCount = livePoints.count
            appliedTerritoryVisible = visible
            guard visible else { return }

            for trip in trips.reversed() {
                let coordinates = trip.territoryPaintPoints.map {
                    CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
                }
                guard coordinates.count > 1 else { continue }

                let casing = MKPolyline(coordinates: coordinates, count: coordinates.count)
                casing.title = "mappy-territory-casing"
                map.addOverlay(casing, level: .aboveRoads)

                let paint = MKPolyline(coordinates: coordinates, count: coordinates.count)
                paint.title = "mappy-territory-paint"
                map.addOverlay(paint, level: .aboveRoads)
            }

            let liveCoordinates = livePoints.map {
                CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
            }
            if liveCoordinates.count > 1 {
                let casing = MKPolyline(coordinates: liveCoordinates, count: liveCoordinates.count)
                casing.title = "mappy-territory-live-casing"
                map.addOverlay(casing, level: .aboveLabels)

                let paint = MKPolyline(coordinates: liveCoordinates, count: liveCoordinates.count)
                paint.title = "mappy-territory-live-paint"
                map.addOverlay(paint, level: .aboveLabels)
            }
        }

        func applyRoutes(_ routes: [MKRoute], selectedRoute: MKRoute?, destination: MKMapItem?, to map: MKMapView) {
            let routesChanged = appliedRoutes.count != routes.count || zip(appliedRoutes, routes).contains { $0 !== $1 }
            if routesChanged || appliedRoute !== selectedRoute {
                let routeLines = map.overlays.compactMap { $0 as? MKPolyline }.filter {
                    !(($0.title ?? "").hasPrefix("mappy-territory"))
                        && !(($0.title ?? "").hasPrefix("mappy-road-pulse"))
                }
                map.removeOverlays(routeLines)
                appliedRoutes = routes
                appliedRoute = selectedRoute
                selectedPolyline = selectedRoute?.polyline
                for alternative in routes where alternative !== selectedRoute {
                    map.addOverlay(alternative.polyline, level: .aboveRoads)
                }
                if let selectedRoute {
                    map.addOverlay(selectedRoute.polyline, level: .aboveLabels)
                    map.setVisibleMapRect(selectedRoute.polyline.boundingMapRect,
                                          edgePadding: UIEdgeInsets(top: 150, left: 45, bottom: 285, right: 45),
                                          animated: true)
                }
            }
            let name = destination?.name
            if appliedDestinationName != name {
                map.removeAnnotations(map.annotations.filter { !($0 is MappyPositionAnnotation) })
                appliedDestinationName = name
                if let destination {
                    let pin = MKPointAnnotation()
                    pin.title = name
                    pin.coordinate = destination.placemark.coordinate
                    map.addAnnotation(pin)
                }
            }
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let tile = overlay as? MKTileOverlay {
                let renderer = MKTileOverlayRenderer(tileOverlay: tile)
                renderer.alpha = 0.92
                return renderer
            }
            if let line = overlay as? MKPolyline {
                let renderer = MKPolylineRenderer(polyline: line)
                if line.title == "mappy-road-pulse" {
                    renderer.strokeColor = UIColor.mappyAccent.withAlphaComponent(0.24)
                    renderer.lineWidth = 8
                    renderer.lineCap = .round
                    renderer.lineJoin = .round
                    return renderer
                }
                if line.title == "mappy-territory-live-casing" {
                    renderer.strokeColor = UIColor.white.withAlphaComponent(0.85)
                    renderer.lineWidth = 13
                    renderer.lineCap = .round
                    renderer.lineJoin = .round
                    return renderer
                }
                if line.title == "mappy-territory-live-paint" {
                    renderer.strokeColor = UIColor.mappyAccent.withAlphaComponent(0.98)
                    renderer.lineWidth = 8
                    renderer.lineCap = .round
                    renderer.lineJoin = .round
                    return renderer
                }
                if line.title == "mappy-territory-casing" {
                    renderer.strokeColor = UIColor.black.withAlphaComponent(0.20)
                    renderer.lineWidth = 11
                    renderer.lineCap = .round
                    renderer.lineJoin = .round
                    return renderer
                }
                if line.title == "mappy-territory-paint" {
                    renderer.strokeColor = UIColor.mappyAccent.withAlphaComponent(0.78)
                    renderer.lineWidth = 7
                    renderer.lineCap = .round
                    renderer.lineJoin = .round
                    return renderer
                }
                let isSelected = line === selectedPolyline
                renderer.strokeColor = isSelected
                    ? UIColor.mappyAccent
                    : UIColor.systemGray.withAlphaComponent(0.65)
                renderer.lineWidth = isSelected ? 6 : 4
                renderer.lineCap = .round
                renderer.lineJoin = .round
                return renderer
            }
            return MKOverlayRenderer(overlay: overlay)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MappyPositionAnnotation {
                let identifier = "mappy-user-arrow"
                let arrow = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                    ?? MKAnnotationView(annotation: annotation, reuseIdentifier: identifier)
                arrow.annotation = annotation
                arrow.image = Self.positionImage
                arrow.canShowCallout = false
                arrow.layer.shadowColor = UIColor.black.cgColor
                arrow.layer.shadowOpacity = 1
                arrow.layer.shadowRadius = 2
                arrow.layer.shadowOffset = .zero
                return arrow
            }
            let identifier = "destination"
            let marker = mapView.dequeueReusableAnnotationView(withIdentifier: identifier) as? MKMarkerAnnotationView
                ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: identifier)
            marker.annotation = annotation
            marker.markerTintColor = .mappyAccent
            marker.glyphImage = UIImage(systemName: "flag.fill")
            return marker
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            guard let model, let location = model.location else { return }
            let mapCenter = CLLocation(
                latitude: mapView.centerCoordinate.latitude,
                longitude: mapView.centerCoordinate.longitude
            )
            model.isMapCentered = mapCenter.distance(from: location) < (appliedDriving ? 180 : 80)
            updateUserArrow(in: mapView, heading: model.navigationHeading)
        }
    }
}

private final class MappyPositionAnnotation: MKPointAnnotation {}

private extension UIColor {
    static let mappyAccent = UIColor(red: 241 / 255, green: 140 / 255, blue: 160 / 255, alpha: 1)
}
