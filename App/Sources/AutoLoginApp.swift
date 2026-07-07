import Cocoa
import SafariServices
import WebKit

private let extensionBundleIdentifier = "Sharbel.AutoLogin.Extension"

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        guard let webView, let resourceURL = Bundle.main.resourceURL else {
            return
        }

        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")

        let onboardingURL = Bundle.main.url(forResource: "Main", withExtension: "html")
            ?? resourceURL.appendingPathComponent("Main.html")

        guard FileManager.default.fileExists(atPath: onboardingURL.path) else {
            return
        }

        webView.loadFileURL(onboardingURL, allowingReadAccessTo: resourceURL)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            guard let state, error == nil else { return }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.body as? String == "open-preferences" else { return }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}
