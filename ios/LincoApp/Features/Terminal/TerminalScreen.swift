import SwiftUI

struct TerminalScreen: View {
    @EnvironmentObject private var model: AppModel
    @State private var terminalOwnerID = UUID()
    let session: RemoteSession
    let streamID: UInt32

    var body: some View {
        ZStack(alignment: .topTrailing) {
            TerminalSurface(
                streamID: streamID,
                output: model.terminalOutput,
                inputDrains: model.terminalInputDrains,
                send: { data in
                    await model.sendTerminalInput(
                        streamID: streamID,
                        sessionID: session.id,
                        generation: session.generation,
                        ownerID: terminalOwnerID,
                        data: data
                    )
                },
                inputRejected: { rejection in
                    model.reportTerminalInputRejection(rejection)
                },
                resize: { columns, rows in
                    await model.resizeTerminal(
                        streamID: streamID,
                        sessionID: session.id,
                        generation: session.generation,
                        ownerID: terminalOwnerID,
                        columns: columns,
                        rows: rows
                    )
                },
                finish: {
                    await model.deactivateTerminal(streamID: streamID, ownerID: terminalOwnerID)
                }
            )
            .allowsHitTesting(model.terminalInputReadyStreams.contains(streamID))
            .background(Color(red: 0.018, green: 0.023, blue: 0.030))

            if !model.connectionStatus.isReady {
                ConnectionPill(status: model.connectionStatus)
                    .padding(10)
            } else if !model.terminalInputReadyStreams.contains(streamID) {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small)
                    Text("正在对齐终端输入…")
                        .font(.caption.weight(.semibold))
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(10)
            }
        }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .task(id: "\(session.streamID):\(session.generation)") {
            await model.activateTerminal(session, ownerID: terminalOwnerID)
        }
    }
}
