import MapKit
import SwiftUI

private enum HUDMenu {
    case drive
    case tools
}

private enum DriveHUDMode {
    case navigation
    case game
}

struct ContentView: View {
    @EnvironmentObject private var model: MappyModel
    @EnvironmentObject private var game: GameStore
    @State private var showingTripPlanner = false
    @State private var showingSettings = false
    @State private var showingSkinStore = false
    @State private var showingLeaderboard = ProcessInfo.processInfo.arguments.contains("-leaderboardPreview")
    @State private var showingDriveEndOptions = false
    @State private var driveHUDMode: DriveHUDMode = .navigation
    @State private var activeHUDMenu: HUDMenu?
    @FocusState private var isSearchFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            let isLandscape = geometry.size.width > geometry.size.height

            ZStack {
                MappyMapView(
                    model: model,
                    territoryTrips: game.trips,
                    liveTerritoryPoints: game.isRecording ? game.livePaintPoints : [],
                    viewportSize: geometry.size
                )
                    .ignoresSafeArea()

                mapChrome(isLandscape: isLandscape)

                HStack {
                    Spacer()
                    sideMapControls
                }
                .padding(.trailing, isLandscape ? 20 : 16)

                if model.isRouting {
                    ProgressView()
                        .controlSize(.large)
                        .padding(24)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
                }
            }
        }
        .task { model.requestLocation() }
        .sheet(isPresented: $showingSettings) { ProfileView() }
        .sheet(isPresented: $showingSkinStore) { SkinStoreView() }
        .sheet(isPresented: $showingLeaderboard) { LeaderboardView() }
        .sheet(isPresented: $model.showingRecap) { TripRecapView() }
        .alert("Guava", isPresented: Binding(
            get: { model.routeError != nil },
            set: { if !$0 { model.routeError = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(model.routeError ?? "") }
        .confirmationDialog(
            "End this drive?",
            isPresented: $showingDriveEndOptions,
            titleVisibility: .visible
        ) {
            Button("Finish & Save") {
                activeHUDMenu = nil
                model.finishDrive()
            }
            Button("Discard Drive", role: .destructive) {
                activeHUDMenu = nil
                model.cancelDrive()
            }
            Button("Keep Driving") { showingDriveEndOptions = false }
        } message: {
            Text("Finish saves a drive of at least 50 metres. Discard removes this drive without XP or territory.")
        }
    }

    private func mapChrome(isLandscape: Bool) -> some View {
        VStack(spacing: isLandscape ? 8 : 12) {
            if model.hasStartedDrive {
                if model.route != nil {
                    HStack {
                        Spacer(minLength: 0)
                        navigationBanner
                            .frame(maxWidth: isLandscape ? 560 : .infinity)
                        Spacer(minLength: 0)
                    }
                }
            } else {
                HStack {
                    if model.selectedSkin == .roadPulse {
                        roadPulsePicker
                    }
                    Spacer(minLength: 0)
                    profileButton
                }
            }
            Spacer(minLength: 8)
            if !model.hasStartedDrive && showingTripPlanner {
                HStack {
                    tripPlannerWorkspace
                        .frame(maxWidth: isLandscape ? 560 : .infinity)
                    if isLandscape { Spacer(minLength: 0) }
                }
            }
            if !showingTripPlanner {
                if model.hasStartedDrive {
                    HStack {
                        Spacer(minLength: 0)
                        activeTripCard(isLandscape: isLandscape)
                            .frame(maxWidth: isLandscape ? 620 : .infinity)
                        Spacer(minLength: 0)
                    }
                } else {
                    bottomHUD(isLandscape: isLandscape)
                }
            }
        }
        .padding(.horizontal, isLandscape ? 20 : 16)
        .padding(.top, isLandscape ? 4 : 8)
        .padding(.bottom, isLandscape ? 4 : 8)
    }

    private var roadPulsePicker: some View {
        VStack(alignment: .leading, spacing: 5) {
            Picker("Road use", selection: $model.roadPulseScope) {
                ForEach(RoadPulseScope.allCases) { scope in
                    Text(scope.rawValue).tag(scope)
                }
            }
            .pickerStyle(.segmented)
            if model.roadPulseScope == .everybody {
                Text("Community road use connects after sign-in is ready")
                    .font(.guava(.caption2))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if game.trips.isEmpty {
                Text("Finish a drive to see your road use")
                    .font(.guava(.caption2))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(7)
        .frame(maxWidth: 260)
        .background(Color.mappySurface, in: RoundedRectangle(cornerRadius: 15))
    }

    private var profileButton: some View {
        Button {
            activeHUDMenu = nil
            showingSettings = true
        } label: {
            Image(systemName: "person.crop.circle.fill")
                .font(.system(size: 23, weight: .semibold))
                .frame(width: 48, height: 48)
                .background(Color.mappySurface, in: Circle())
                .foregroundStyle(Color.mappyInk)
                .shadow(color: .black.opacity(0.10), radius: 8, y: 3)
        }
        .accessibilityLabel("Profile and settings")
    }

    private var tripPlannerBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.secondary)
            TextField("Where to?", text: $model.searchText)
                .textInputAutocapitalization(.words)
                .submitLabel(.search)
                .focused($isSearchFocused)
            if !model.searchText.isEmpty {
                Button { model.searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
            }
            Button {
                isSearchFocused = false
                model.searchText = ""
                model.clearRoute()
                withAnimation(.easeOut(duration: 0.2)) { showingTripPlanner = false }
            } label: {
                Image(systemName: "xmark")
                    .font(.guava(.caption, face: .bold))
                    .frame(width: 32, height: 32)
                    .background(.quaternary, in: Circle())
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 54)
        .background(Color.mappySurface, in: RoundedRectangle(cornerRadius: 19))
        .shadow(color: .black.opacity(0.10), radius: 12, y: 5)
    }

    @ViewBuilder
    private var tripPlannerWorkspace: some View {
        if let route = model.route {
            routeCard(route)
        } else {
            VStack(spacing: 8) {
                searchResults
                tripPlannerBar
            }
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        if !model.searchText.isEmpty && !model.suggestions.isEmpty {
            VStack(spacing: 0) {
                ForEach(model.suggestions) { place in
                    Button {
                        isSearchFocused = false
                        Task {
                            await model.choose(place)
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "mappin.circle.fill")
                                .foregroundStyle(Color.mappyAccent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(place.title).font(.guava(.subheadline, face: .demi)).foregroundStyle(.primary)
                                Text(place.subtitle).font(.guava(.caption)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                        }
                        .padding(13)
                    }
                    if place.id != model.suggestions.last?.id { Divider().padding(.leading, 48) }
                }
            }
            .background(Color.mappySurface, in: RoundedRectangle(cornerRadius: 20))
            .shadow(color: .black.opacity(0.1), radius: 14, y: 6)
        }
    }

    private func routeCard(_ route: MKRoute) -> some View {
        VStack(spacing: 13) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.destinationTitle).font(.guava(.headline, face: .demi)).lineLimit(1)
                    Text("\(duration(route.expectedTravelTime)) · \(distance(route.distance))")
                        .font(.guava(.subheadline)).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        Label("Traffic layer", systemImage: "car.2.fill")
                        if route.hasTolls { Label("Tolls", systemImage: "creditcard.fill") }
                    }
                    .font(.guava(.caption, face: .demi))
                    .foregroundStyle(.secondary)
                }
                Spacer()
                if model.selectedSkin == .altitude {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(model.altitudeText).font(.guava(.headline, face: .demi).monospacedDigit())
                        Text("CURRENT ALTITUDE").font(.guava(size: 9, face: .bold, relativeTo: .caption2)).foregroundStyle(.secondary)
                    }
                }
                Button {
                    model.clearRoute()
                    DispatchQueue.main.async { isSearchFocused = true }
                } label: {
                    Image(systemName: "xmark").font(.guava(.caption, face: .bold)).padding(9).background(.quaternary, in: Circle())
                }
            }
            if model.routes.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(model.routes.enumerated()), id: \.offset) { index, option in
                            Button { model.selectRoute(option) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(index == 0 ? "Fastest" : "Option \(index + 1)")
                                        .font(.guava(.caption, face: .demi))
                                    Text("\(duration(option.expectedTravelTime)) · \(distance(option.distance))")
                                        .font(.guava(.caption2))
                                }
                                .foregroundStyle(Color.mappyInk)
                                .padding(.horizontal, 12)
                                .frame(height: 46)
                                .background(model.route === option ? Color.mappyAccent : Color.mappyInk.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                            }
                        }
                    }
                }
            }
            if !route.advisoryNotices.isEmpty {
                Label(route.advisoryNotices.prefix(2).joined(separator: " · "), systemImage: "exclamationmark.triangle.fill")
                    .font(.guava(.caption))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                Button {
                    isSearchFocused = false
                    showingTripPlanner = false
                    driveHUDMode = .navigation
                    model.startDrive()
                } label: {
                    Label("Start", systemImage: "play.fill")
                        .font(.guava(.headline, face: .demi))
                        .foregroundStyle(Color.mappyInk)
                        .padding(.horizontal, 22)
                        .frame(height: 48)
                        .background(Color.mappyAccent, in: Capsule())
                }
                .accessibilityLabel("Start route")
            }
        }
        .padding(16)
        .background(Color.mappySurface, in: RoundedRectangle(cornerRadius: 24))
        .shadow(color: .black.opacity(0.13), radius: 18, y: 7)
    }

    private func activeTripCard(isLandscape: Bool) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let stats = HStack(spacing: 2) {
                if driveHUDMode == .navigation, model.route != nil {
                    compactDriveStat(duration(model.remainingTravelTime), "REMAINING")
                    compactDriveStat(distance(model.remainingRouteDistance), "TO GO")
                    compactDriveStat(Date(timeIntervalSinceNow: model.remainingTravelTime).formatted(date: .omitted, time: .shortened), "ARRIVAL")
                } else {
                    compactDriveStat(clock(game.elapsedTime(at: context.date)), "TIME")
                    compactDriveStat(distance(game.liveDistanceMeters), "DRIVEN")
                    compactDriveStat(height(game.liveHeightMeters), "HEIGHT")
                    compactDriveStat(territoryDistance(game.liveTerritoryMeters), "ROAD")
                }
            }

            Group {
                if isLandscape {
                    HStack(spacing: 10) {
                        driveCardTitle
                        stats
                        driveCardActions
                    }
                } else {
                    VStack(spacing: 5) {
                        HStack(spacing: 8) {
                            driveCardTitle
                            Spacer(minLength: 0)
                            driveCardActions
                        }
                        Divider()
                        stats
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, isLandscape ? 8 : 7)
            .frame(maxWidth: .infinity)
            .background(Color.mappySurface, in: RoundedRectangle(cornerRadius: 20))
            .shadow(color: .black.opacity(0.13), radius: 10, y: 4)
        }
    }

    private var driveCardTitle: some View {
        HStack(spacing: 6) {
            Circle().fill(.green).frame(width: 7, height: 7)
            Text(model.route == nil ? "Free drive" : (driveHUDMode == .navigation ? "Navigation" : "Drive stats"))
                .font(.guava(.caption, face: .demi))
                .lineLimit(1)
        }
        .foregroundStyle(Color.mappyInk)
    }

    private var driveCardActions: some View {
        HStack(spacing: 5) {
            Button { showingSkinStore = true } label: {
                Image(systemName: "square.3.layers.3d")
                    .frame(width: 35, height: 35)
            }
            .accessibilityLabel("Change map")
            if model.route != nil {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        driveHUDMode = driveHUDMode == .navigation ? .game : .navigation
                    }
                } label: {
                    Image(systemName: driveHUDMode == .navigation ? "gamecontroller.fill" : "map.fill")
                        .frame(width: 35, height: 35)
                }
                .accessibilityLabel(driveHUDMode == .navigation ? "Show game statistics" : "Show navigation information")
            }
            Button { showingDriveEndOptions = true } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.mappyInk)
                    .frame(width: 35, height: 35)
                    .background(Color.mappyAccent, in: RoundedRectangle(cornerRadius: 10))
            }
            .accessibilityLabel("End drive")
        }
        .font(.guava(size: 15, face: .demi, relativeTo: .subheadline))
        .foregroundStyle(Color.mappyInk)
        .buttonStyle(.plain)
    }

    private var navigationBanner: some View {
        HStack(alignment: .center, spacing: 13) {
            Image(systemName: model.currentManeuverIcon)
                .font(.system(size: 29, weight: .bold))
                .frame(width: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(model.currentManeuverDistance > 0 ? distanceShort(model.currentManeuverDistance) : "Now")
                    .font(.guava(.caption, face: .bold))
                    .foregroundStyle(Color.mappyInk.opacity(0.65))
                Text(model.currentManeuverInstruction)
                    .font(.guava(size: 17, face: .demi, relativeTo: .headline))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.mappyInk)
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, minHeight: 74)
        .background(Color.mappyAccent, in: RoundedRectangle(cornerRadius: 18))
        .shadow(color: .black.opacity(0.16), radius: 12, y: 4)
    }

    private func compactDriveStat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.guava(size: 12, face: .bold, relativeTo: .caption).monospacedDigit())
                .minimumScaleFactor(0.75)
                .lineLimit(1)
            Text(label)
                .font(.guava(size: 7, face: .bold, relativeTo: .caption2))
                .foregroundStyle(.secondary)
                .minimumScaleFactor(0.8)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 38)
    }

    private func bottomHUD(isLandscape: Bool) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                if activeHUDMenu == .drive {
                    driveMenu
                        .transition(.scale(scale: 0.86, anchor: .bottomLeading).combined(with: .opacity))
                }
                Button {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        activeHUDMenu = activeHUDMenu == .drive ? nil : .drive
                    }
                } label: {
                    ZStack {
                        Circle()
                            .fill(driveButtonFill)
                        if activeHUDMenu == .drive {
                            Circle()
                                .stroke(Color.mappyAccent, lineWidth: 5)
                            Image(systemName: "xmark")
                                .foregroundStyle(Color.mappyAccent)
                        } else {
                            Image(systemName: "play.fill")
                                .foregroundStyle(Color.mappyInk)
                        }
                    }
                    .font(.system(size: 23, weight: .bold))
                    .frame(width: 64, height: 64)
                }
                .accessibilityLabel("Open drive options")
            }
            Spacer(minLength: 0)
            if model.selectedSkin == .altitude {
                Text(model.altitudeText)
                    .monospacedDigit()
                    .font(.guava(.subheadline, face: .bold))
                    .padding(.horizontal, 10)
                    .frame(height: 42)
                    .background(Color.mappySurface, in: Capsule())
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 8) {
                if activeHUDMenu == .tools {
                    toolsMenu
                        .transition(.scale(scale: 0.86, anchor: .bottomTrailing).combined(with: .opacity))
                }
                Button {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        activeHUDMenu = activeHUDMenu == .tools ? nil : .tools
                    }
                } label: {
                    ZStack {
                        Circle().fill(activeHUDMenu == .tools ? Color.mappySurface : Color.mappyAccent)
                        if activeHUDMenu == .tools {
                            Circle().stroke(Color.mappyAccent, lineWidth: 4)
                            Image(systemName: "xmark")
                        } else {
                            Image(systemName: "slider.horizontal.3")
                        }
                    }
                    .font(.guava(.headline, face: .demi))
                    .frame(width: 52, height: 52)
                    .foregroundStyle(Color.mappyInk)
                }
                .accessibilityLabel("Open Guava controls")
            }
        }
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
    }

    private var driveMenu: some View {
        VStack(alignment: .leading, spacing: 10) {
            menuCircleButton("Quick start", icon: "car.fill", tint: Color.mappyAccent) {
                activeHUDMenu = nil
                model.clearRoute()
                driveHUDMode = .game
                model.startDrive()
            }
            menuCircleButton("Plan drive", icon: "magnifyingglass", tint: Color.mappyAccent) {
                activeHUDMenu = nil
                withAnimation(.easeOut(duration: 0.2)) { showingTripPlanner = true }
                DispatchQueue.main.async { isSearchFocused = true }
            }
        }
    }

    private var toolsMenu: some View {
        VStack(alignment: .trailing, spacing: 10) {
            menuCircleButton("Leaderboard", icon: "trophy.fill", tint: Color.mappyAccent, labelOnLeft: true) {
                activeHUDMenu = nil
                showingLeaderboard = true
            }
            menuCircleButton("Maps", icon: "map.fill", tint: Color.mappyAccent, labelOnLeft: true) {
                activeHUDMenu = nil
                showingSkinStore = true
            }
        }
    }

    private func menuCircleButton(
        _ title: String,
        icon: String,
        tint: Color,
        labelOnLeft: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if labelOnLeft { menuLabel(title) }
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .bold))
                    .frame(width: 48, height: 48)
                    .background(tint, in: Circle())
                    .foregroundStyle(Color.mappyInk)
                if !labelOnLeft { menuLabel(title) }
            }
        }
        .accessibilityLabel(title)
    }

    private func menuLabel(_ title: String) -> some View {
        Text(title)
            .font(.guava(.caption, face: .bold))
            .foregroundStyle(Color.mappyInk)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(Color.mappySurface, in: Capsule())
    }

    private var driveButtonFill: AnyShapeStyle {
        if activeHUDMenu == .drive {
            return AnyShapeStyle(Color.mappySurface)
        }
        return AnyShapeStyle(Color.mappyAccent)
    }

    private var sideMapControls: some View {
        VStack(spacing: 8) {
            VStack(spacing: 0) {
                Button { model.zoomIn() } label: {
                    Image(systemName: "plus").frame(width: 36, height: 36)
                }
                Divider().frame(width: 22)
                Button { model.zoomOut() } label: {
                    Image(systemName: "minus").frame(width: 36, height: 36)
                }
            }
            .frame(width: 36)
            .background(Color.mappySurface, in: RoundedRectangle(cornerRadius: 12))

            Button { model.centerOrToggleOrientation() } label: {
                ZStack {
                    Circle().fill(Color.mappySurface)
                    Image(systemName: model.isMapCentered && model.mapOrientationMode == .north
                          ? "location.north.fill"
                          : "location.fill")
                        .font(.guava(.subheadline, face: .bold))
                }
                .frame(width: 36, height: 36)
            }
            .accessibilityLabel(model.isMapCentered
                                ? "Switch to \(model.mapOrientationMode == .north ? "point of view" : "north up") mode"
                                : "Center map on me")
        }
        .font(.guava(.subheadline, face: .bold))
        .foregroundStyle(Color.mappyInk)
        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
    }

    private func duration(_ seconds: TimeInterval) -> String {
        let minutes = max(1, Int(seconds / 60))
        return minutes >= 60 ? "\(minutes / 60) hr \(minutes % 60) min" : "\(minutes) min"
    }

    private func distance(_ meters: CLLocationDistance) -> String {
        String(format: "%.1f km", meters / 1000)
    }

    private func height(_ meters: CLLocationDistance) -> String {
        meters >= 1000 ? String(format: "%.1f km", meters / 1000) : "\(Int(meters.rounded())) m"
    }

    private func territoryDistance(_ meters: CLLocationDistance) -> String {
        meters >= 1000 ? String(format: "%.1f km", meters / 1000) : "\(Int(meters.rounded())) m"
    }

    private func distanceShort(_ meters: CLLocationDistance) -> String {
        meters >= 1000 ? String(format: "%.1f km", meters / 1000) : "\(max(1, Int(meters.rounded()))) m"
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let remainingSeconds = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, remainingSeconds)
            : String(format: "%02d:%02d", minutes, remainingSeconds)
    }
}

extension Color {
    static let mappyAccent = Color(red: 241 / 255, green: 140 / 255, blue: 160 / 255)
    static let mappySurface = Color.white
    static let mappyInk = Color(red: 0.12, green: 0.12, blue: 0.12)
    static let guavaSecondary = Color(red: 0.39, green: 0.37, blue: 0.37)
    static let guavaCard = Color(red: 0.985, green: 0.975, blue: 0.97)
}

enum GuavaFontFace {
    case regular, medium, demi, bold, heavy

    var postScriptName: String {
        switch self {
        case .regular: "AvenirNext-Regular"
        case .medium: "AvenirNext-Medium"
        case .demi: "AvenirNext-DemiBold"
        case .bold: "AvenirNext-Bold"
        case .heavy: "AvenirNext-Heavy"
        }
    }
}

extension Font {
    static func guava(_ style: Font.TextStyle, face: GuavaFontFace = .regular) -> Font {
        let size: CGFloat = switch style {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        @unknown default: 17
        }
        return .custom(face.postScriptName, size: size, relativeTo: style)
    }

    static func guava(size: CGFloat, face: GuavaFontFace = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(face.postScriptName, size: size, relativeTo: style)
    }
}
