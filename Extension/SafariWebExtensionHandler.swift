import SafariServices
import Security
import os.log

/// Handles `browser.runtime.sendNativeMessage` requests from the extension.
///
/// Secrets are stored in the macOS Keychain as generic-password items keyed by
/// opaque ids (`secretRef`s); the extension's storage never sees the values.
/// Logging is deliberately limited to the action name — never payloads.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let keychainService = "Sharbel.AutoLogin.credentials"

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]

        let payload = message as? [String: Any]
        let action = payload?["action"] as? String ?? ""
        os_log(.default, "AutoLogin native request: %{public}@", action.isEmpty ? "unknown" : action)

        let reply = handle(action: action, payload: payload ?? [:])

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func handle(action: String, payload: [String: Any]) -> [String: Any] {
        switch action {
        case "set-secret":
            guard let id = payload["id"] as? String, !id.isEmpty,
                  let value = payload["value"] as? String else {
                return ["ok": false, "message": "Missing id or value."]
            }
            return ["ok": setSecret(id: id, value: value)]

        case "get-secrets":
            let ids = payload["ids"] as? [String] ?? []
            var values: [String: String] = [:]
            for id in ids {
                if let value = getSecret(id: id) {
                    values[id] = value
                }
            }
            return ["ok": true, "values": values]

        case "delete-secrets":
            let ids = payload["ids"] as? [String] ?? []
            for id in ids {
                deleteSecret(id: id)
            }
            return ["ok": true]

        case "delete-all-secrets":
            deleteAllSecrets()
            return ["ok": true]

        default:
            return ["ok": false, "message": "Unknown action."]
        }
    }

    // MARK: - Keychain

    private func baseQuery(id: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: id
        ]
    }

    private func setSecret(id: String, value: String) -> Bool {
        guard let data = value.data(using: .utf8) else {
            return false
        }

        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery(id: id) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess {
            return true
        }

        guard status == errSecItemNotFound else {
            return false
        }

        var query = baseQuery(id: id)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    private func getSecret(id: String) -> String? {
        var query = baseQuery(id: id)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }

    private func deleteSecret(id: String) {
        SecItemDelete(baseQuery(id: id) as CFDictionary)
    }

    private func deleteAllSecrets() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService
        ]
        SecItemDelete(query as CFDictionary)
    }
}
