import UIKit
import UniformTypeIdentifiers

/**
 * Teremu Share Extension (docs/share-target.md). No compose UI: it copies
 * every shared photo / PDF into the App Group's SharedInbox, opens
 * Teremu (teremu://share) and closes. The main app's ShareTarget plugin
 * picks the files up from there and hands them to the scanner.
 *
 * Copied into app/ios/App/ShareExtension/ by hand once (see the doc) —
 * this file is the source of truth; keep the two in sync.
 */
class ShareViewController: UIViewController {
    // Must match capacitor.config.ts → plugins.ShareTarget.appGroupId and
    // both targets' App Groups entitlement.
    private let appGroupId = "group.com.teremu.app"
    private let hostURL = URL(string: "teremu://share")!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        spinner.startAnimating()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await importAndHandOff() }
    }

    private func importAndHandOff() async {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        var saved = 0
        // Sequential on purpose: extensions get ~120 MB, and decoding
        // several 12 MP photos at once can get us killed.
        for (index, provider) in providers.enumerated() {
            if await save(provider, prefix: "\(stamp)-\(index)-") { saved += 1 }
        }
        await MainActor.run {
            if saved > 0 { openHostApp() }
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private var inbox: URL? {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else { return nil }
        let dir = container.appendingPathComponent("SharedInbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func save(_ provider: NSItemProvider, prefix: String) async -> Bool {
        guard let inbox else { return false }
        if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
            guard let data = await loadData(provider, type: .pdf) else { return false }
            let name = sanitized(provider.suggestedName, ext: "pdf")
            return write(data, to: inbox, name: prefix + name)
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            // JPEG / PNG pass through untouched; HEIC and anything else is
            // re-encoded to JPEG so every WebView and the OCR read it.
            let type = provider.registeredTypeIdentifiers.compactMap { UTType($0) }.first { $0.conforms(to: .image) } ?? .image
            guard let data = await loadData(provider, type: type) else { return false }
            if type.conforms(to: .jpeg) || type.conforms(to: .png) {
                let ext = type.conforms(to: .png) ? "png" : "jpg"
                return write(data, to: inbox, name: prefix + sanitized(provider.suggestedName, ext: ext))
            }
            guard let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) else { return false }
            return write(jpeg, to: inbox, name: prefix + sanitized(provider.suggestedName, ext: "jpg"))
        }
        return false
    }

    /// File representation first (no full decode in memory), then the
    /// item itself — some apps (WhatsApp, Messages) only vend a URL,
    /// Data or a UIImage.
    private func loadData(_ provider: NSItemProvider, type: UTType) async -> Data? {
        let fromFile: Data? = await withCheckedContinuation { done in
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                done.resume(returning: url.flatMap { try? Data(contentsOf: $0) })
            }
        }
        if let fromFile { return fromFile }
        return await withCheckedContinuation { done in
            provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in
                switch item {
                case let url as URL: done.resume(returning: try? Data(contentsOf: url))
                case let data as Data: done.resume(returning: data)
                case let image as UIImage: done.resume(returning: image.jpegData(compressionQuality: 0.9))
                default: done.resume(returning: nil)
                }
            }
        }
    }

    private func sanitized(_ suggested: String?, ext: String) -> String {
        let base = (suggested ?? "shared")
            .replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
        let stem = (base as NSString).deletingPathExtension
        return (stem.isEmpty ? "shared" : stem) + "." + ext
    }

    /// Written as .part and renamed, so the app never lists half a file.
    private func write(_ data: Data, to dir: URL, name: String) -> Bool {
        let partial = dir.appendingPathComponent(name + ".part")
        do {
            try data.write(to: partial, options: .atomic)
            try FileManager.default.moveItem(at: partial, to: dir.appendingPathComponent(name))
            return true
        } catch {
            try? FileManager.default.removeItem(at: partial)
            return false
        }
    }

    /// Extensions can't call UIApplication.shared; the responder chain
    /// still reaches the host UIApplication. If this ever stops working,
    /// nothing is lost — the app finds the files next time it's opened.
    private func openHostApp() {
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication {
                application.open(hostURL, options: [:], completionHandler: nil)
                return
            }
            responder = current.next
        }
    }
}
