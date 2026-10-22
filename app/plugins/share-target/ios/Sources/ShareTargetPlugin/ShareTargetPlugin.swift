import Foundation
import UIKit
import Capacitor
import UniformTypeIdentifiers

/**
 * Share-sheet target, main-app half (docs/share-target.md). The Share
 * Extension (ios-extension/) drops files into the App Group's
 * SharedInbox; getPending() moves them into this app's caches (where the
 * WebView can load them) and lists them. Pull-based, so a share that
 * cold-starts the app or arrives while it's suspended is never lost.
 */
@objc(ShareTargetPlugin)
public class ShareTargetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareTargetPlugin"
    public let jsName = "ShareTarget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    private static let groupInboxName = "SharedInbox"
    private static let partialSuffix = ".part"

    override public func load() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleOpenURL(_:)), name: .capacitorOpenURL, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleBecameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// teremu://share — the extension opened us right after saving.
    @objc private func handleOpenURL(_ notification: Notification) {
        guard let object = notification.object as? [String: Any],
              let url = object["url"] as? URL,
              url.host == "share" else { return }
        notifyListeners("shareReceived", data: [:], retainUntilConsumed: true)
    }

    /// The extension couldn't open us (or the user came back by hand).
    @objc private func handleBecameActive() {
        if !groupFiles().isEmpty {
            notifyListeners("shareReceived", data: [:], retainUntilConsumed: true)
        }
    }

    private var appGroupId: String {
        getConfig().getString("appGroupId") ?? "group.com.teremu.app"
    }

    private var groupInbox: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?
            .appendingPathComponent(Self.groupInboxName, isDirectory: true)
    }

    private var localInbox: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = caches.appendingPathComponent("shared-inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func groupFiles() -> [URL] {
        guard let inbox = groupInbox,
              let items = try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)
        else { return [] }
        return items.filter { !$0.lastPathComponent.hasSuffix(Self.partialSuffix) }
    }

    /// Files waiting to be scanned, oldest share first: [{ path, name, mimeType }].
    @objc func getPending(_ call: CAPPluginCall) {
        let fm = FileManager.default
        let local = localInbox
        for file in groupFiles() {
            let target = local.appendingPathComponent(file.lastPathComponent)
            try? fm.removeItem(at: target)
            if (try? fm.moveItem(at: file, to: target)) == nil {
                // Different volume / container quirk — copy, then drop the original.
                if (try? fm.copyItem(at: file, to: target)) != nil { try? fm.removeItem(at: file) }
            }
        }
        let items = (try? fm.contentsOfDirectory(at: local, includingPropertiesForKeys: nil)) ?? []
        let files: [[String: Any]] = items
            .filter { !$0.lastPathComponent.hasSuffix(Self.partialSuffix) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { url in
                // Strip the "<stamp>-<index>-" prefix back to the sender's file name.
                let name = url.lastPathComponent.replacingOccurrences(
                    of: "^\\d+-\\d+-", with: "", options: .regularExpression)
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                return ["path": url.path, "name": name, "mimeType": mime]
            }
        call.resolve(["files": files])
    }

    /// Deletes the given inbox files (only inbox files — never an arbitrary path).
    @objc func clear(_ call: CAPPluginCall) {
        let root = localInbox.standardizedFileURL.path + "/"
        for path in call.getArray("paths", String.self) ?? [] {
            let url = URL(fileURLWithPath: path).standardizedFileURL
            if url.path.hasPrefix(root) { try? FileManager.default.removeItem(at: url) }
        }
        call.resolve()
    }
}
