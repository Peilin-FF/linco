import Foundation
import SwiftUI
@preconcurrency import SwiftTerm
import UIKit

enum TerminalRendererPolicy {
    static func shouldAttemptMetal(isAttachedToWindow: Bool, hasAttempted: Bool) -> Bool {
        isAttachedToWindow && !hasAttempted
    }
}

private final class LincoTerminalView: TerminalView {
    var onAttachedToWindow: (() -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { onAttachedToWindow?() }
    }
}

@MainActor
struct TerminalSurface: UIViewRepresentable {
    let streamID: UInt32
    let output: TerminalOutputHub
    let inputDrains: TerminalInputDrainRegistry
    let send: @Sendable (Data) async -> Void
    let inputRejected: @MainActor @Sendable (OrderedTerminalInputPump.Rejection) -> Void
    let resize: @Sendable (Int, Int) async -> Void
    let finish: @MainActor @Sendable () async -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            streamID: streamID,
            inputDrains: inputDrains,
            send: send,
            inputRejected: inputRejected,
            resize: resize,
            finish: finish
        )
    }

    func makeUIView(context: Context) -> TerminalView {
        let terminal = LincoTerminalView(frame: .zero)
        terminal.terminalDelegate = context.coordinator
        terminal.font = .monospacedSystemFont(ofSize: 13.5, weight: .regular)
        terminal.nativeBackgroundColor = UIColor(red: 0.018, green: 0.023, blue: 0.030, alpha: 1)
        terminal.nativeForegroundColor = UIColor(white: 0.91, alpha: 1)
        terminal.optionAsMetaKey = true
        terminal.allowMouseReporting = true
        terminal.metalBufferingMode = .perRowPersistent
        terminal.onAttachedToWindow = { [weak terminal, weak coordinator = context.coordinator] in
            guard let terminal, let coordinator else { return }
            coordinator.enableMetalIfPossible(on: terminal)
        }
        context.coordinator.start(view: terminal, output: output, streamID: streamID)
        return terminal
    }

    func updateUIView(_ terminal: TerminalView, context: Context) {
        context.coordinator.enableMetalIfPossible(on: terminal)
    }

    static func dismantleUIView(_ terminal: TerminalView, coordinator: Coordinator) {
        coordinator.stop()
        (terminal as? LincoTerminalView)?.onAttachedToWindow = nil
        terminal.terminalDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        private let inputPump: OrderedTerminalInputPump
        private let resizePump: CoalescingTerminalResizePump
        private let streamID: UInt32
        private let inputDrains: TerminalInputDrainRegistry
        private let inputDrainToken = UUID()
        private let finish: @MainActor @Sendable () async -> Void
        private weak var output: TerminalOutputHub?
        private var outputSubscription: TerminalOutputSubscription?
        private var hasAttemptedMetal = false
        private var hasStopped = false

        init(
            streamID: UInt32,
            inputDrains: TerminalInputDrainRegistry,
            send: @escaping @Sendable (Data) async -> Void,
            inputRejected: @escaping @MainActor @Sendable (OrderedTerminalInputPump.Rejection) -> Void,
            resize: @escaping @Sendable (Int, Int) async -> Void,
            finish: @escaping @MainActor @Sendable () async -> Void
        ) {
            self.streamID = streamID
            self.inputDrains = inputDrains
            self.finish = finish
            self.inputPump = OrderedTerminalInputPump(onRejected: inputRejected, sender: send)
            self.resizePump = CoalescingTerminalResizePump { size in
                await resize(size.columns, size.rows)
            }
            super.init()
        }

        func start(view: TerminalView, output: TerminalOutputHub, streamID: UInt32) {
            self.output = output
            let inputPump = self.inputPump
            inputDrains.register(
                streamID: streamID,
                token: inputDrainToken,
                pause: { inputPump.pauseAcceptance() },
                resume: { inputPump.resumeAcceptance() },
                drain: { await inputPump.waitUntilDrained() }
            )
            outputSubscription = output.subscribe(to: streamID) { update in
                if update.reset {
                    view.getTerminal().resetToInitialState()
                    view.clearSelection()
                }
                guard !update.data.isEmpty else { return }
                let bytes = [UInt8](update.data)
                view.feed(byteArray: bytes[...])
            }
        }

        func stop() {
            guard !hasStopped else { return }
            hasStopped = true
            // Close the synchronous delegate boundary before output ownership
            // changes. Already accepted input still drains before `finish`
            // performs the sole terminal detach.
            inputPump.closeAndDrain()
            if let outputSubscription {
                output?.unsubscribe(outputSubscription)
            }
            outputSubscription = nil
            output = nil
            resizePump.closeDiscardingPending()
            let inputPump = self.inputPump
            let inputDrains = self.inputDrains
            let streamID = self.streamID
            let inputDrainToken = self.inputDrainToken
            let finish = self.finish
            Task { @MainActor in
                await inputPump.waitUntilDrained()
                inputDrains.unregister(streamID: streamID, token: inputDrainToken)
                await finish()
            }
        }

        func enableMetalIfPossible(on view: TerminalView) {
            guard TerminalRendererPolicy.shouldAttemptMetal(
                isAttachedToWindow: view.window != nil,
                hasAttempted: hasAttemptedMetal
            ) else { return }
            hasAttemptedMetal = true
#if canImport(MetalKit)
            // SwiftTerm defaults to Core Graphics. Enabling Metal before the
            // view has a window is unsupported, so attachment is the one-shot
            // activation point; failure safely leaves the CG renderer active.
            try? view.setUseMetal(true)
#endif
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            inputPump.enqueue(Data(data))
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            resizePump.enqueue(columns: newCols, rows: newRows)
        }

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return }
            Task { @MainActor in await UIApplication.shared.open(url) }
        }

        func bell(source: TerminalView) {
            Task { @MainActor in UINotificationFeedbackGenerator().notificationOccurred(.warning) }
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func clipboardRead(source: TerminalView) -> Data? { nil }
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
