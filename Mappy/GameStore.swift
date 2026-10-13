import CoreLocation
import Foundation
import MapKit

struct TerritoryCell: Codable, Hashable, Identifiable {
    static let sizeMeters = 25.0
    private static let earthRadius = 6_378_137.0

    let x: Int
    let y: Int

    var id: String { "\(x):\(y)" }

    init(coordinate: CLLocationCoordinate2D) {
        let longitude = coordinate.longitude * .pi / 180
        let latitude = min(85, max(-85, coordinate.latitude)) * .pi / 180
        let projectedX = Self.earthRadius * longitude
        let projectedY = Self.earthRadius * log(tan(.pi / 4 + latitude / 2))
        x = Int(floor(projectedX / Self.sizeMeters))
        y = Int(floor(projectedY / Self.sizeMeters))
    }

    var polygon: MKPolygon {
        let corners = [
            coordinate(x: Double(x), y: Double(y)),
            coordinate(x: Double(x + 1), y: Double(y)),
            coordinate(x: Double(x + 1), y: Double(y + 1)),
            coordinate(x: Double(x), y: Double(y + 1))
        ]
        return MKPolygon(coordinates: corners, count: corners.count)
    }

    private func coordinate(x: Double, y: Double) -> CLLocationCoordinate2D {
        let projectedX = x * Self.sizeMeters
        let projectedY = y * Self.sizeMeters
        let longitude = projectedX / Self.earthRadius
        let latitude = 2 * atan(exp(projectedY / Self.earthRadius)) - .pi / 2
        return CLLocationCoordinate2D(latitude: latitude * 180 / .pi, longitude: longitude * 180 / .pi)
    }
}

struct TripPoint: Codable {
    let latitude: Double
    let longitude: Double
    let altitude: Double?
    let timestamp: Date
}

struct RecordedTrip: Codable, Identifiable {
    let id: UUID
    let startedAt: Date
    let endedAt: Date
    let distanceMeters: Double
    let heightTraveledMeters: Double
    let ascentMeters: Double
    let descentMeters: Double
    let cells: [TerritoryCell]
    let newCellCount: Int
    let xpEarned: Int
    let points: [TripPoint]
    /// Route-projected points when navigation supplied a road polyline; absent on older/free-drive records.
    let paintPoints: [TripPoint]?
    var duration: TimeInterval { endedAt.timeIntervalSince(startedAt) }
    var territoryPaintPoints: [TripPoint] {
        guard let paintPoints, paintPoints.count > 1 else { return points }
        return paintPoints
    }
}

enum LeaderboardMetric: String, CaseIterable, Identifiable {
    case xp = "Guava XP"
    case height = "Height Traveled"
    case territory = "Territory"
    case distance = "Distance"

    var id: String { rawValue }
}

struct LeaderboardPlayer: Identifiable {
    let id: String
    let name: String
    let initials: String
    let isCurrentUser: Bool
    let xp: Double
    let height: Double
    let territory: Double
    let distance: Double

    func value(for metric: LeaderboardMetric) -> Double {
        switch metric {
        case .xp: xp
        case .height: height
        case .territory: territory
        case .distance: distance
        }
    }
}

@MainActor
final class GameStore: ObservableObject {
    static let minimumDriveDistanceMeters = 50.0
    @Published private(set) var trips: [RecordedTrip] = []
    @Published private(set) var claimedCells: Set<TerritoryCell> = []
    @Published private(set) var isRecording = false
    @Published private(set) var liveDistanceMeters = 0.0
    @Published private(set) var liveHeightMeters = 0.0
    @Published private(set) var liveCellCount = 0
    @Published private(set) var livePaintPoints: [TripPoint] = []
    @Published private(set) var lastTrip: RecordedTrip?

    private var startedAt: Date?
    private var points: [TripPoint] = []
    private var driveCells: Set<TerritoryCell> = []
    private var paintRoute: MKPolyline?
    private var lastAcceptedLocation: CLLocation?
    private var altitudeAnchor: Double?
    private var liveAscentMeters = 0.0
    private var liveDescentMeters = 0.0

    // v2 intentionally starts a new territory grid: v1 cells were encoded at 250 m.
    private let storageKey = "mappy.local.game.v2"

    init() {
        load()
    }

    var totalDistanceMeters: Double { trips.reduce(0) { $0 + $1.distanceMeters } }
    var totalHeightMeters: Double { trips.reduce(0) { $0 + $1.heightTraveledMeters } }
    /// Prototype estimate: each hidden claim unit represents roughly 25 m of unique painted road.
    var totalTerritoryMeters: Double { Double(claimedCells.count) * TerritoryCell.sizeMeters }
    var liveTerritoryMeters: Double { Double(liveCellCount) * TerritoryCell.sizeMeters }
    var totalXP: Int { trips.reduce(0) { $0 + $1.xpEarned } }
    var totalDuration: TimeInterval { trips.reduce(0) { $0 + $1.duration } }
    var averageSpeedKilometresPerHour: Double {
        totalDuration > 0 ? totalDistanceMeters / totalDuration * 3.6 : 0
    }
    var highestAltitudeMeters: Double {
        trips.lazy.flatMap(\.points).compactMap(\.altitude).max() ?? 0
    }

    func elapsedTime(at date: Date = Date()) -> TimeInterval {
        guard isRecording, let startedAt else { return 0 }
        return max(0, date.timeIntervalSince(startedAt))
    }

    func start(at location: CLLocation?, route: MKPolyline? = nil) {
        guard !isRecording else { return }
        startedAt = Date()
        points = []
        livePaintPoints = []
        driveCells = []
        paintRoute = route
        lastAcceptedLocation = nil
        altitudeAnchor = nil
        liveDistanceMeters = 0
        liveHeightMeters = 0
        liveAscentMeters = 0
        liveDescentMeters = 0
        liveCellCount = 0
        isRecording = true
        if let location { record(location) }
    }

    func updatePaintRoute(_ route: MKPolyline?) {
        guard isRecording else { return }
        paintRoute = route
    }

    func record(_ location: CLLocation) {
        guard isRecording,
              location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= 50 else { return }

        if let previous = lastAcceptedLocation {
            let movement = location.distance(from: previous)
            if movement >= 5, movement <= 300 {
                liveDistanceMeters += movement
                addCells(from: previous.coordinate, to: location.coordinate, distance: movement)
                lastAcceptedLocation = location
                appendPoint(location)
                appendPaintPoint(location)
            }
        } else {
            lastAcceptedLocation = location
            appendPoint(location)
            appendPaintPoint(location)
        }

        liveCellCount = driveCells.count

        guard location.verticalAccuracy >= 0, location.verticalAccuracy <= 30 else { return }
        if let altitudeAnchor {
            let delta = location.altitude - altitudeAnchor
            guard abs(delta) >= 3 else { return }
            liveHeightMeters += abs(delta)
            if delta > 0 { liveAscentMeters += delta } else { liveDescentMeters += abs(delta) }
            self.altitudeAnchor = location.altitude
        } else {
            altitudeAnchor = location.altitude
        }
    }

    @discardableResult
    func finish() -> RecordedTrip? {
        guard isRecording, let startedAt else { return nil }
        isRecording = false
        self.startedAt = nil

        guard liveDistanceMeters >= Self.minimumDriveDistanceMeters else {
            lastTrip = nil
            return nil
        }

        let previousCells = claimedCells
        let newCells = driveCells.subtracting(previousCells)
        let distanceXP = Int((liveDistanceMeters / 1000 * 8).rounded(.down))
        let heightXP = Int((liveHeightMeters / 20).rounded(.down))
        let xp = 10 + distanceXP + heightXP + newCells.count * 2
        let trip = RecordedTrip(
            id: UUID(),
            startedAt: startedAt,
            endedAt: Date(),
            distanceMeters: liveDistanceMeters,
            heightTraveledMeters: liveHeightMeters,
            ascentMeters: liveAscentMeters,
            descentMeters: liveDescentMeters,
            cells: Array(driveCells),
            newCellCount: newCells.count,
            xpEarned: xp,
            points: points,
            paintPoints: livePaintPoints
        )
        trips.insert(trip, at: 0)
        if trips.count > 50 { trips.removeLast(trips.count - 50) }
        claimedCells.formUnion(driveCells)
        lastTrip = trip
        save()
        return trip
    }

    func cancel() {
        guard isRecording else { return }
        isRecording = false
        startedAt = nil
        points = []
        livePaintPoints = []
        driveCells = []
        paintRoute = nil
        lastAcceptedLocation = nil
        altitudeAnchor = nil
        liveDistanceMeters = 0
        liveHeightMeters = 0
        liveAscentMeters = 0
        liveDescentMeters = 0
        liveCellCount = 0
        lastTrip = nil
    }

    private func addCells(
        from start: CLLocationCoordinate2D,
        to end: CLLocationCoordinate2D,
        distance: CLLocationDistance
    ) {
        let sampleSpacing = TerritoryCell.sizeMeters / 2
        let steps = min(100, max(1, Int(ceil(distance / sampleSpacing))))
        for step in 0...steps {
            let fraction = Double(step) / Double(steps)
            let coordinate = CLLocationCoordinate2D(
                latitude: start.latitude + (end.latitude - start.latitude) * fraction,
                longitude: start.longitude + (end.longitude - start.longitude) * fraction
            )
            driveCells.insert(TerritoryCell(coordinate: coordinate))
        }
    }

    func leaderboard(metric: LeaderboardMetric) -> [LeaderboardPlayer] {
        let me = LeaderboardPlayer(
            id: "me", name: "You", initials: "S", isCurrentUser: true,
            xp: Double(totalXP), height: totalHeightMeters,
            territory: totalTerritoryMeters, distance: totalDistanceMeters
        )
        let previewPlayers = [
            LeaderboardPlayer(id: "maya", name: "Maya", initials: "M", isCurrentUser: false, xp: 860, height: 4_420, territory: 18_500, distance: 192_000),
            LeaderboardPlayer(id: "noam", name: "Noam", initials: "N", isCurrentUser: false, xp: 710, height: 5_830, territory: 15_250, distance: 241_000),
            LeaderboardPlayer(id: "lior", name: "Lior", initials: "L", isCurrentUser: false, xp: 620, height: 3_190, territory: 22_000, distance: 174_000),
            LeaderboardPlayer(id: "dana", name: "Dana", initials: "D", isCurrentUser: false, xp: 490, height: 6_240, territory: 11_500, distance: 128_000)
        ]
        return ([me] + previewPlayers).sorted { $0.value(for: metric) > $1.value(for: metric) }
    }

    private func appendPoint(_ location: CLLocation) {
        let altitude = location.verticalAccuracy >= 0 && location.verticalAccuracy <= 30 ? location.altitude : nil
        points.append(TripPoint(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            altitude: altitude,
            timestamp: location.timestamp
        ))
    }

    private func appendPaintPoint(_ location: CLLocation) {
        let coordinate: CLLocationCoordinate2D
        if let projection = paintRoute?.nearestCoordinate(to: location.coordinate), projection.distance <= 100 {
            coordinate = projection.coordinate
        } else {
            coordinate = location.coordinate
        }
        let altitude = location.verticalAccuracy >= 0 && location.verticalAccuracy <= 30 ? location.altitude : nil
        livePaintPoints.append(TripPoint(
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
            altitude: altitude,
            timestamp: location.timestamp
        ))
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(trips) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let savedTrips = try? JSONDecoder().decode([RecordedTrip].self, from: data) else { return }
        trips = savedTrips
        claimedCells = Set(savedTrips.flatMap(\.cells))
    }
}

private extension MKPolyline {
    func nearestCoordinate(to coordinate: CLLocationCoordinate2D) -> (coordinate: CLLocationCoordinate2D, distance: CLLocationDistance)? {
        guard pointCount > 0 else { return nil }
        let target = MKMapPoint(coordinate)
        let routePoints = points()
        guard pointCount > 1 else {
            return (routePoints[0].coordinate, target.distance(to: routePoints[0]))
        }

        var closestPoint = routePoints[0]
        var closestDistance = CLLocationDistance.greatestFiniteMagnitude
        for index in 0..<(pointCount - 1) {
            let start = routePoints[index]
            let end = routePoints[index + 1]
            let dx = end.x - start.x
            let dy = end.y - start.y
            let lengthSquared = dx * dx + dy * dy
            let fraction = lengthSquared == 0
                ? 0
                : max(0, min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared))
            let candidate = MKMapPoint(x: start.x + fraction * dx, y: start.y + fraction * dy)
            let distance = target.distance(to: candidate)
            if distance < closestDistance {
                closestPoint = candidate
                closestDistance = distance
            }
        }
        return (closestPoint.coordinate, closestDistance)
    }
}
