import SwiftUI

// MARK: - Add Account View

public struct AddAccountView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var label = ""
    @State private var serverUrl = "https://"
    @State private var username = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String? = nil

    public init() {}

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Label (optional)", text: $label)
                    TextField("CalDAV Server URL", text: $serverUrl)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                } header: {
                    Text("Server")
                } footer: {
                    Text("Enter the full CalDAV server URL.\nExample: https://api.cirrux.co/")
                        .font(.caption)
                }

                Section("Credentials") {
                    TextField("Username", text: $username)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    SecureField("Password / App Password", text: $password)
                }

                if let err = errorMessage {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.subheadline)
                    }
                }
            }
            .navigationTitle("Add Account")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isLoading {
                        ProgressView()
                    } else {
                        Button("Connect") {
                            Task { await connect() }
                        }
                        .disabled(serverUrl.isEmpty || username.isEmpty || password.isEmpty)
                    }
                }
            }
        }
    }

    // MARK: - Connect

    private func connect() async {
        isLoading = true
        errorMessage = nil
        let input = AccountConnectionInput(
            label: label,
            serverUrl: serverUrl,
            connectionMode: .direct,
            username: username,
            password: password
        )
        await state.addAccount(input: input)
        if state.globalError == nil {
            dismiss()
        } else {
            errorMessage = state.globalError
            state.globalError = nil
        }
        isLoading = false
    }
}
