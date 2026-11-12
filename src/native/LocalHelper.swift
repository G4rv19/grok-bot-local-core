import AppKit
import ApplicationServices
import ScreenCaptureKit
import Security
import Darwin

struct LocalFailure: Error { let message: String; var policyDenied = false }
func fail(_ message: String) -> LocalFailure { LocalFailure(message: message) }

@MainActor final class MacTools {
    var targets: [Int32: String] = [:]
    var snapshots: [Int32: (String, [Int: AXUIElement])] = [:]
    var views: [Int32: (String, CGRect)] = [:]

    func apps() -> [[String: Any]] {
        NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { app in
            let pid = app.processIdentifier
            let id = targets[pid] ?? UUID().uuidString
            targets[pid] = id
            return ["name": app.localizedName ?? "App", "pid": Int(pid), "bundle_id": app.bundleIdentifier ?? "",
                    "target": ["scope": "app", "pid": Int(pid), "target_id": id]]
        }
    }
    func app(_ args: [String: Any]) throws -> NSRunningApplication {
        guard let target = args["target"] as? [String: Any], let pid = target["pid"] as? Int, let nativePID = Int32(exactly: pid),
              let id = target["target_id"] as? String, targets[nativePID] == id,
              let app = NSRunningApplication(processIdentifier: nativePID), !app.isTerminated else {
            throw fail("Resolve the app with computer_apps or computer_resolve_app before acting.")
        }
        return app
    }
    func ax(_ element: AXUIElement, _ name: CFString) -> AnyObject? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
        return value
    }
    func requireAccessibility() throws {
        guard AXIsProcessTrusted() else { throw fail("Accessibility permission is required for Grok Bot Local Helper in System Settings → Privacy & Security → Accessibility.") }
    }
    func state(_ args: [String: Any]) throws -> [String: Any] {
        try requireAccessibility()
        let application = try app(args), pid = application.processIdentifier
        let root = args["element_id"] != nil ? try element(args) : AXUIElementCreateApplication(pid), snapshot = UUID().uuidString
        var elements: [Int: AXUIElement] = [:], lines: [String] = [], next = 1, truncated = false
        func visit(_ element: AXUIElement, _ depth: Int) {
            guard depth < 48, next <= 1600 else { truncated = true; return }
            let id = next; next += 1; elements[id] = element
            let role = ax(element, kAXRoleAttribute as CFString) as? String ?? "element"
            let title = ax(element, kAXTitleAttribute as CFString) as? String ?? ""
            let description = ax(element, kAXDescriptionAttribute as CFString) as? String ?? ""
            let value = ax(element, kAXValueAttribute as CFString).map { String(describing: $0).prefix(2000) } ?? ""
            var actions: CFArray?
            AXUIElementCopyActionNames(element, &actions)
            let actionNames = actions as? [String] ?? []
            lines.append(String(repeating: "  ", count: depth) + "[\(id)] \(role) \(title) \(description) \(value) actions=\(actionNames.joined(separator: ","))")
            // Closed menu trees can be much larger than the visible app. They
            // remain inspectable by requesting this element as a subtree.
            if role == "AXMenuBar" && depth > 0 { return }
            for child in ax(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? [] { visit(child, depth + 1) }
        }
        visit(root, 0); snapshots[pid] = (snapshot, elements)
        return ["snapshot_id": snapshot, "target": args["target"]!, "tree": lines.joined(separator: "\n"), "truncated": truncated]
    }
    func element(_ args: [String: Any]) throws -> AXUIElement {
        let application = try app(args)
        guard let id = args["element_id"] as? Int, let snapshot = args["snapshot_id"] as? String,
              let current = snapshots[application.processIdentifier], current.0 == snapshot, let element = current.1[id] else {
            throw fail("The accessibility snapshot is stale. Read computer_app_state again.")
        }
        return element
    }
    func screenshot(_ args: [String: Any]) async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else { throw fail("Screen Recording permission is required for Grok Bot Local Helper in System Settings → Privacy & Security.") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter, frame: CGRect, pid: Int32
        if let target = args["target"] as? [String: Any], target["scope"] as? String == "app" {
            let application = try app(args); pid = application.processIdentifier
            // Electron and macOS can add transparent sharing/utility windows.
            // Prefer the app's named content window, then the largest window.
            let candidates = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 20 && $0.frame.height > 20 }
            let named = candidates.filter { !($0.title ?? "").isEmpty && $0.title != "Window" }
            guard let window = (named.isEmpty ? candidates : named).max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { throw fail("No visible window for this app.") }
            filter = SCContentFilter(desktopIndependentWindow: window); frame = window.frame
        } else {
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { throw fail("No display is available.") }
            filter = SCContentFilter(display: display, excludingWindows: []); frame = CGDisplayBounds(display.displayID); pid = 0
        }
        // Capture the window's own aspect ratio, then map the whole image to the
        // declared canvas. Coordinate conversion must match the delivered pixels.
        let config = SCStreamConfiguration(); config.width = max(1, Int(frame.width)); config.height = max(1, Int(frame.height)); config.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let canvas = CGContext(data: nil, width: 1280, height: 800, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw fail("Could not create screenshot canvas.") }
        canvas.draw(image, in: CGRect(x: 0, y: 0, width: 1280, height: 800))
        guard let scaled = canvas.makeImage(), let png = NSBitmapImageRep(cgImage: scaled).representation(using: .png, properties: [:]) else { throw fail("Could not encode screenshot.") }
        let token = UUID().uuidString; views[pid] = (token, frame)
        return ["coordinate_token": token, "width": 1280, "height": 800,
                "content": [["type": "image", "mimeType": "image/png", "data": png.base64EncodedString()]]]
    }
    func point(_ args: [String: Any], x: Double? = nil, y: Double? = nil) throws -> CGPoint {
        let pid: Int32 = (args["target"] as? [String: Any])?["scope"] as? String == "app" ? try app(args).processIdentifier : 0
        guard let view = views[pid], let token = args["coordinate_token"] as? String, token == view.0,
              let px = x ?? args["x"] as? Double, let py = y ?? args["y"] as? Double,
              px >= 0, px <= 1280, py >= 0, py <= 800 else { throw fail("Use coordinates and coordinate_token from a fresh screenshot.") }
        return CGPoint(x: view.1.minX + px / 1280 * view.1.width, y: view.1.minY + py / 800 * view.1.height)
    }
    func activate(_ args: [String: Any]) async throws {
        try requireAccessibility()
        if (args["target"] as? [String: Any])?["scope"] as? String == "app" {
            let application = try app(args)
            application.activate(options: [])
            for _ in 0..<100 {
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier { return }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            throw fail("The target app could not become active. No input was sent.")
        }
    }
    func mouse(_ type: CGEventType, _ point: CGPoint, button: CGMouseButton = .left, count: Int = 1) throws {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw fail("Could not create mouse event.") }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count)); event.post(tap: .cghidEventTap)
    }
    func call(_ name: String, _ args: [String: Any], allowedApps: Set<String>? = nil) async throws -> [String: Any] {
        func allowed(_ bundle: String?) throws {
            if let allowedApps, !allowedApps.contains(bundle ?? "") { throw LocalFailure(message: "Unattended app access needs a standing grant in Settings → Computer.", policyDenied: true) }
        }
        if allowedApps != nil && !["computer_apps", "computer_resolve_app", "computer_wait", "computer_check_permissions"].contains(name) {
            guard args["target"] != nil else { throw LocalFailure(message: "Unattended actions need an approved app target.", policyDenied: true) }
            try allowed(app(args).bundleIdentifier)
        }
        let mutations = ["computer_set_value", "computer_app_action", "computer_type", "computer_key", "computer_click", "computer_drag", "computer_scroll"]
        defer { if mutations.contains(name) { snapshots.removeAll(); views.removeAll() } }
        switch name {
        case "computer_check_permissions": return ["accessibility": AXIsProcessTrusted(), "screen_recording": CGPreflightScreenCaptureAccess()]
        case "computer_apps": return ["apps": apps().filter { allowedApps == nil || allowedApps!.contains($0["bundle_id"] as? String ?? "") }]
        case "computer_resolve_app":
            let selectors = ["pid", "bundle_id", "app_path", "app_name"].filter { args[$0] != nil }
            guard selectors.count == 1 else { throw fail("Provide exactly one app selector.") }
            var running: NSRunningApplication?
            if let pid = args["pid"] as? Int, let nativePID = Int32(exactly: pid) { running = NSRunningApplication(processIdentifier: nativePID) }
            if let bundle = args["bundle_id"] as? String { running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first }
            if let name = args["app_name"] as? String { running = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame }) }
            if running == nil {
                let url: URL?
                if let file = args["app_path"] as? String { url = URL(fileURLWithPath: file) }
                else if let bundle = args["bundle_id"] as? String { url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) }
                else {
                    let name = args["app_name"] as? String ?? ""
                    url = ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
                        .map { URL(fileURLWithPath: $0).appendingPathComponent(name + ".app") }
                        .first { FileManager.default.fileExists(atPath: $0.path) }
                }
                guard let url else { throw fail("App was not found. Provide its bundle_id or app_path.") }
                guard url.pathExtension == "app", Bundle(url: url) != nil else { throw fail("Expected a valid application bundle.") }
                try allowed(Bundle(url: url)?.bundleIdentifier)
                running = try await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
            }
            guard let running else { throw fail("App was not found.") }
            try allowed(running.bundleIdentifier)
            _ = apps(); let pid = running.processIdentifier; let id = targets[pid] ?? UUID().uuidString; targets[pid] = id
            return ["name": running.localizedName ?? "App", "pid": Int(pid), "bundle_id": running.bundleIdentifier ?? "", "target": ["scope": "app", "pid": Int(pid), "target_id": id]]
        case "computer_app_state": return try state(args)
        case "computer_screenshot": return try await screenshot(args)
        case "computer_wait": try await Task.sleep(nanoseconds: UInt64(min(max(args["ms"] as? Int ?? 1000, 0), 30000)) * 1_000_000); return ["waited": true]
        case "computer_set_value":
            try requireAccessibility(); let item = try element(args)
            guard let value = args["value"] else { throw fail("Provide value.") }
            let result = AXUIElementSetAttributeValue(item, kAXValueAttribute as CFString, value as CFTypeRef)
            guard result == .success else { throw fail("App refused value change: \(result.rawValue)") }; return ["changed": true]
        case "computer_app_action":
            try requireAccessibility(); let item = try element(args)
            guard let action = args["action"] as? String else { throw fail("Provide the AX action name.") }
            let result = AXUIElementPerformAction(item, (action == "press" ? kAXPressAction as String : action) as CFString)
            guard result == .success else { throw fail("App refused action: \(result.rawValue)") }; return ["performed": true]
        case "computer_type":
            try await activate(args)
            guard let text = args["text"] as? String else { throw fail("Provide text.") }
            if args["element_id"] != nil {
                let item = try element(args)
                guard AXUIElementSetAttributeValue(item, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { throw fail("Could not focus this element. Use computer_set_value or click it first.") }
            }
            let chars = Array(text.utf16)
            for down in [true, false] { let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down); chars.withUnsafeBufferPointer { buffer in if let base = buffer.baseAddress { event?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: base) } }; event?.post(tap: .cghidEventTap) }
            return ["typed": true]
        case "computer_key":
            try await activate(args)
            let key = (args["key"] as? String ?? "").lowercased().split(separator: "+").map(String.init)
            let codes: [String: CGKeyCode] = ["return":36,"enter":36,"tab":48,"space":49,"escape":53,"esc":53,"backspace":51,"delete":51,"forwarddelete":117,"home":115,"end":119,"pageup":116,"pagedown":121,"left":123,"right":124,"down":125,"up":126,"a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46,"0":29,"1":18,"2":19,"3":20,"4":21,"5":23,"6":22,"7":26,"8":28,"9":25,"-":27,"=":24,"[":33,"]":30,";":41,"'":39,",":43,".":47,"/":44,"\\":42,"`":50]
            guard let last = key.last, let code = codes[last] else { throw fail("Unsupported key. Use computer_type for text.") }
            var flags: CGEventFlags = []
            if key.contains("cmd") || key.contains("super") { flags.insert(.maskCommand) }; if key.contains("shift") { flags.insert(.maskShift) }; if key.contains("alt") || key.contains("option") { flags.insert(.maskAlternate) }; if key.contains("ctrl") || key.contains("control") { flags.insert(.maskControl) }
            for down in [true, false] { let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down); event?.flags = flags; event?.post(tap: .cghidEventTap) }; return ["pressed": true]
        case "computer_click", "computer_move", "computer_drag", "computer_scroll":
            try await activate(args)
            let buttonName = args["button"] as? String ?? "left"
            let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
            let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
            let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
            if name == "computer_drag" {
                guard let from = args["from"] as? [String: Double], let to = args["to"] as? [String: Double] else { throw fail("Provide from and to coordinates.") }
                let first = try point(args, x: from["x"], y: from["y"]), last = try point(args, x: to["x"], y: to["y"])
                try mouse(down, first, button: button)
                for step in 1...20 { try mouse(button == .right ? .rightMouseDragged : button == .center ? .otherMouseDragged : .leftMouseDragged, CGPoint(x: first.x + (last.x-first.x)*Double(step)/20, y:first.y+(last.y-first.y)*Double(step)/20), button: button); try await Task.sleep(nanoseconds: 10_000_000) }
                try mouse(up, last, button: button)
            } else if name == "computer_scroll" {
                try mouse(.mouseMoved, point(args))
                let amount = Int32(min(max(args["amount"] as? Int ?? 3, 1), 20) * 40); let direction = args["direction"] as? String ?? "down"
                CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: direction == "up" ? amount : direction == "down" ? -amount : 0, wheel2: direction == "left" ? amount : direction == "right" ? -amount : 0, wheel3: 0)?.post(tap: .cghidEventTap)
            } else {
                let location = try point(args)
                if name == "computer_move" { try mouse(.mouseMoved, location) }
                else { let count = min(max(args["count"] as? Int ?? 1,1),3); for i in 1...count { try mouse(down, location, button:button,count:i); try mouse(up,location,button:button,count:i) } }
            }
            return ["performed": true, "refresh_required": true]
        default: throw fail("Unknown native tool.")
        }
    }
}

@main struct LocalHelper {
    static func parentIsLocalApp() -> Bool {
        guard getuid() == geteuid(), let parent = NSRunningApplication(processIdentifier: getppid()),
              parent.bundleIdentifier == "local.garv.grokbot", let executable = parent.executableURL else { return false }
        let host = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let expected = host.appendingPathComponent("Contents/MacOS/Grok Bot").resolvingSymlinksInPath()
        guard executable.resolvingSymlinksInPath() == expected else { return false }
        var code: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: getppid())] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess, let code else { return false }
        return SecCodeCheckValidity(code, SecCSFlags(), nil) == errSecSuccess
    }
    @MainActor static func main() async {
        // ScreenCaptureKit requires AppKit's WindowServer connection even in a
        // stdio helper. Initialize the accessory application before capturing.
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.finishLaunching()
        let tools = MacTools()
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = request["id"] else { continue }
            var response: [String: Any] = ["jsonrpc":"2.0","id":id]
            do {
                let method = request["method"] as? String ?? ""
                if method == "initialize" { response["result"] = ["protocolVersion":"2024-11-05","capabilities":["tools":[:]],"serverInfo":["name":"grok-bot-local-helper","version":"1.0"]] }
                else if method == "tools/list" {
                    let url = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/computer-tools.json")
                    var catalog = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
                    catalog["tools"] = (catalog["tools"] as? [[String: Any]] ?? []).filter { !["computer_start_control", "computer_release_control"].contains($0["name"] as? String ?? "") }
                    response["result"] = catalog
                } else if method == "tools/call" {
                    let params = request["params"] as? [String: Any] ?? [:]
                    if params["name"] as? String != "computer_check_permissions" && !parentIsLocalApp() { throw fail("This helper accepts actions only from its signed Grok Bot Local host.") }
                    let allowedApps = (params["allowed_apps"] as? [String]).map { Set($0) }
                    let result = try await tools.call(params["name"] as? String ?? "", params["arguments"] as? [String: Any] ?? [:], allowedApps: allowedApps)
                    var content: [[String: Any]] = [["type":"text","text":String(data:try JSONSerialization.data(withJSONObject:result.filter { $0.key != "content" }),encoding:.utf8)!]]
                    content += result["content"] as? [[String:Any]] ?? []
                    response["result"] = ["content":content]
                } else { throw fail("Unknown helper method.") }
            } catch {
                let message = (error as? LocalFailure)?.message ?? error.localizedDescription
                response["result"] = ["isError":true,"policyDenied":(error as? LocalFailure)?.policyDenied ?? false,"content":[["type":"text","text":message]]]
            }
            if let data = try? JSONSerialization.data(withJSONObject:response), let text = String(data:data,encoding:.utf8) { print(text); fflush(stdout) }
        }
    }
}
