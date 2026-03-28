import Foundation

// MARK: - Persistence Controller

/// Stores and loads app state as JSON files in the app's Application Support directory.
public final class PersistenceController: @unchecked Sendable {

    public static let shared = PersistenceController()

    private let fileManager = FileManager.default
    private lazy var storageDirectory: URL = {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("TaskManagerNative", isDirectory: true)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private var snapshotURL: URL { storageDirectory.appendingPathComponent("snapshot.json") }

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    // MARK: - Load

    public func loadSnapshot() -> AppSnapshot {
        guard fileManager.fileExists(atPath: snapshotURL.path) else { return AppSnapshot() }
        do {
            let data = try Data(contentsOf: snapshotURL)
            return try decoder.decode(AppSnapshot.self, from: data)
        } catch {
            print("[Persistence] Failed to load snapshot: \(error)")
            return AppSnapshot()
        }
    }

    // MARK: - Save

    public func saveSnapshot(_ snapshot: AppSnapshot) {
        do {
            let data = try encoder.encode(snapshot)
            try data.write(to: snapshotURL, options: .atomic)
        } catch {
            print("[Persistence] Failed to save snapshot: \(error)")
        }
    }

    // MARK: - Clear

    public func clearAll() {
        try? fileManager.removeItem(at: snapshotURL)
    }
}
