import SwiftUI
import WebKit

struct IsolatedPreviewWebView: UIViewRepresentable {
    let capability: HTTPCapability

    func makeCoordinator() -> Coordinator { Coordinator(allowedOrigin: capability.url) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isInspectable = false
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        load(capability, in: webView, coordinator: context.coordinator)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedCapability != capability.token else { return }
        load(capability, in: webView, coordinator: context.coordinator)
    }

    private func load(_ capability: HTTPCapability, in webView: WKWebView, coordinator: Coordinator) {
        var request = URLRequest(url: capability.url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(capability.authorizationValue, forHTTPHeaderField: "Authorization")
        coordinator.loadedCapability = capability.token
        webView.load(request)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let allowedScheme: String?
        private let allowedHost: String?
        private let allowedPort: Int?
        var loadedCapability: String?

        init(allowedOrigin: URL) {
            self.allowedScheme = allowedOrigin.scheme?.lowercased()
            self.allowedHost = allowedOrigin.host?.lowercased()
            self.allowedPort = allowedOrigin.port
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            let isAllowed = url.scheme?.lowercased() == allowedScheme
                && url.host?.lowercased() == allowedHost
                && url.port == allowedPort
            decisionHandler(isAllowed ? .allow : .cancel)
        }
    }
}
