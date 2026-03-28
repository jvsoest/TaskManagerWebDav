import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

// MARK: - CalDAV Error

public enum CalDAVError: LocalizedError {
    case invalidURL(String)
    case authenticationFailed(Int)
    case serverError(Int, String)
    case networkError(Error)
    case unexpectedResponse(String)
    case notFound
    case conflict(String)
    case preconditionFailed(String)
    case homeSetsNotFound

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let u):          return "Invalid URL: \(u)"
        case .authenticationFailed(let c): return "Authentication failed (\(c)). Check your username and password."
        case .serverError(let c, let m):  return "Server error \(c): \(m)"
        case .networkError(let e):        return "Network error: \(e.localizedDescription)"
        case .unexpectedResponse(let m):  return "Unexpected server response: \(m)"
        case .notFound:                   return "Resource not found (404)."
        case .conflict(let m):            return "Conflict: \(m)"
        case .preconditionFailed(let m):  return "Precondition failed: \(m)"
        case .homeSetsNotFound:           return "Could not find CalDAV home set. Check the server URL."
        }
    }
}

// MARK: - XML namespaces

private enum NS {
    static let dav      = "DAV:"
    static let caldav   = "urn:ietf:params:xml:ns:caldav"
    static let cs       = "http://calendarserver.org/ns/"
    static let ical     = "http://apple.com/ns/ical/"
}

// MARK: - Helper types

public struct DiscoveredCollection: Sendable {
    public var url: String
    public var displayName: String
    public var description: String?
    public var color: String?
    public var ctag: String?
    public var syncToken: String?
    public var supportsVTODO: Bool
}

public struct FetchedVTODO: Sendable {
    public var url: String
    public var etag: String?
    public var icsData: String
}

// MARK: - CalDAV Client

/// A native CalDAV HTTP client using URLSession.
/// No CORS proxy is needed — native apps can call any URL directly.
public actor CalDAVClient {

    // MARK: - Initialization

    private let session: URLSession

    public init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        // Allow self-signed certs for local test servers (remove in production if desired)
        session = URLSession(configuration: config)
    }

    // MARK: - Public API

    /// Discover CalDAV home sets starting from serverUrl and return the list.
    public func discoverHomeSets(serverURL: String, username: String, password: String) async throws -> [String] {
        guard let url = URL(string: serverURL.ensureTrailingSlash()) else {
            throw CalDAVError.invalidURL(serverURL)
        }

        let propfindBody = """
        <?xml version="1.0" encoding="UTF-8"?>
        <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
          <d:prop>
            <d:current-user-principal/>
            <c:calendar-home-set/>
            <d:displayname/>
          </d:prop>
        </d:propfind>
        """

        // First try the given URL
        let response = try await davRequest(
            method: "PROPFIND",
            url: url,
            headers: ["Depth": "0", "Content-Type": "application/xml; charset=utf-8"],
            body: propfindBody,
            username: username,
            password: password
        )

        let text = response.body
        let baseURL = response.finalURL ?? url.absoluteString

        // Parse current-user-principal
        if let principalHref = xmlPropertyHref(text, localName: "current-user-principal") {
            let principalURL = resolveURL(principalHref, base: baseURL)
            // Follow principal to get calendar-home-set
            let principalResponse = try await davRequest(
                method: "PROPFIND",
                url: URL(string: principalURL)!,
                headers: ["Depth": "0", "Content-Type": "application/xml; charset=utf-8"],
                body: propfindBody,
                username: username,
                password: password
            )
            if let homeHref = xmlPropertyHref(principalResponse.body, localName: "calendar-home-set") {
                return [resolveURL(homeHref, base: principalResponse.finalURL ?? principalURL)]
            }
        }

        // Direct calendar-home-set in the initial response
        if let homeHref = xmlPropertyHref(text, localName: "calendar-home-set") {
            return [resolveURL(homeHref, base: baseURL)]
        }

        // Fallback: try /caldav/ and /
        let candidates = [
            url.absoluteString,
            url.absoluteString.ensureTrailingSlash() + "caldav/",
            url.absoluteString.ensureTrailingSlash() + "dav/",
        ]
        return candidates
    }

    /// List all calendar collections at a given home-set URL.
    public func listCollections(at homeURL: String, username: String, password: String) async throws -> [DiscoveredCollection] {
        guard let url = URL(string: homeURL) else { throw CalDAVError.invalidURL(homeURL) }
        let body = """
        <?xml version="1.0" encoding="UTF-8"?>
        <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">
          <d:prop>
            <d:resourcetype/>
            <d:displayname/>
            <d:getetag/>
            <c:supported-calendar-component-set/>
            <cs:getctag/>
            <d:sync-token/>
            <ical:calendar-color/>
            <c:calendar-description/>
          </d:prop>
        </d:propfind>
        """
        let response = try await davRequest(
            method: "PROPFIND",
            url: url,
            headers: ["Depth": "1", "Content-Type": "application/xml; charset=utf-8"],
            body: body,
            username: username,
            password: password
        )
        return parseCollections(from: response.body, baseURL: response.finalURL ?? homeURL)
    }

    /// Fetch all VTODO resources from a calendar collection URL.
    public func fetchVTODOs(from collectionURL: String, username: String, password: String, syncToken: String? = nil) async throws -> (items: [FetchedVTODO], newSyncToken: String?) {
        guard let url = URL(string: collectionURL) else { throw CalDAVError.invalidURL(collectionURL) }

        if let token = syncToken {
            // Try sync-collection REPORT
            let syncBody = """
            <?xml version="1.0" encoding="UTF-8"?>
            <d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
              <d:sync-token>\(token)</d:sync-token>
              <d:sync-level>1</d:sync-level>
              <d:prop>
                <d:getetag/>
                <c:calendar-data/>
              </d:prop>
            </d:sync-collection>
            """
            let response = try await davRequest(
                method: "REPORT",
                url: url,
                headers: ["Depth": "1", "Content-Type": "application/xml; charset=utf-8"],
                body: syncBody,
                username: username,
                password: password
            )
            if response.statusCode == 207 {
                let items = parseCalendarDataResponses(from: response.body)
                let newToken = xmlTextContent(response.body, localName: "sync-token")
                return (items, newToken ?? token)
            }
            // Fallback to full fetch if server doesn't support sync-collection
        }

        // Full calendar-query REPORT
        let queryBody = """
        <?xml version="1.0" encoding="UTF-8"?>
        <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <d:getetag/>
            <c:calendar-data/>
          </d:prop>
          <c:filter>
            <c:comp-filter name="VCALENDAR">
              <c:comp-filter name="VTODO"/>
            </c:comp-filter>
          </c:filter>
        </c:calendar-query>
        """
        let response = try await davRequest(
            method: "REPORT",
            url: url,
            headers: ["Depth": "1", "Content-Type": "application/xml; charset=utf-8"],
            body: queryBody,
            username: username,
            password: password
        )
        let items = parseCalendarDataResponses(from: response.body)
        // Get new ctag/sync-token via PROPFIND
        let newToken = try? await fetchSyncToken(collectionURL: collectionURL, username: username, password: password)
        return (items, newToken)
    }

    /// PUT a VTODO to a specific URL, returns the new etag.
    @discardableResult
    public func putVTODO(to resourceURL: String, icsData: String, etag: String?, username: String, password: String) async throws -> String? {
        guard let url = URL(string: resourceURL) else { throw CalDAVError.invalidURL(resourceURL) }
        var headers: [String: String] = ["Content-Type": "text/calendar; charset=utf-8"]
        if let etag = etag {
            headers["If-Match"] = etag
        } else {
            headers["If-None-Match"] = "*"
        }
        let response = try await davRequest(
            method: "PUT",
            url: url,
            headers: headers,
            body: icsData,
            username: username,
            password: password
        )
        guard [200, 201, 204].contains(response.statusCode) else {
            throw CalDAVError.serverError(response.statusCode, response.body)
        }
        return response.headers["etag"] ?? response.headers["ETag"]
    }

    /// DELETE a resource.
    public func deleteResource(at resourceURL: String, etag: String?, username: String, password: String) async throws {
        guard let url = URL(string: resourceURL) else { throw CalDAVError.invalidURL(resourceURL) }
        var headers: [String: String] = [:]
        if let etag = etag { headers["If-Match"] = etag }
        let response = try await davRequest(
            method: "DELETE",
            url: url,
            headers: headers,
            body: nil,
            username: username,
            password: password
        )
        guard [200, 204, 404].contains(response.statusCode) else {
            throw CalDAVError.serverError(response.statusCode, response.body)
        }
    }

    /// Create a calendar collection (MKCALENDAR).
    public func makeCalendar(at collectionURL: String, displayName: String, username: String, password: String) async throws {
        guard let url = URL(string: collectionURL) else { throw CalDAVError.invalidURL(collectionURL) }
        let body = """
        <?xml version="1.0" encoding="UTF-8"?>
        <c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:set>
            <d:prop>
              <d:displayname>\(xmlEscape(displayName))</d:displayname>
              <c:supported-calendar-component-set>
                <c:comp name="VTODO"/>
              </c:supported-calendar-component-set>
            </d:prop>
          </d:set>
        </c:mkcalendar>
        """
        let response = try await davRequest(
            method: "MKCALENDAR",
            url: url,
            headers: ["Content-Type": "application/xml; charset=utf-8"],
            body: body,
            username: username,
            password: password
        )
        guard [200, 201].contains(response.statusCode) else {
            throw CalDAVError.serverError(response.statusCode, response.body)
        }
    }

    /// Rename a collection via PROPPATCH.
    public func renameCollection(at collectionURL: String, newName: String, username: String, password: String) async throws {
        guard let url = URL(string: collectionURL) else { throw CalDAVError.invalidURL(collectionURL) }
        let body = """
        <?xml version="1.0" encoding="UTF-8"?>
        <d:propertyupdate xmlns:d="DAV:">
          <d:set>
            <d:prop>
              <d:displayname>\(xmlEscape(newName))</d:displayname>
            </d:prop>
          </d:set>
        </d:propertyupdate>
        """
        let response = try await davRequest(
            method: "PROPPATCH",
            url: url,
            headers: ["Content-Type": "application/xml; charset=utf-8"],
            body: body,
            username: username,
            password: password
        )
        guard [200, 207].contains(response.statusCode) else {
            throw CalDAVError.serverError(response.statusCode, response.body)
        }
    }

    /// Update the calendar-color via PROPPATCH.
    public func updateCalendarColor(at collectionURL: String, color: String, username: String, password: String) async throws {
        guard let url = URL(string: collectionURL) else { throw CalDAVError.invalidURL(collectionURL) }
        let body = """
        <?xml version="1.0" encoding="UTF-8"?>
        <d:propertyupdate xmlns:d="DAV:" xmlns:ical="http://apple.com/ns/ical/">
          <d:set>
            <d:prop>
              <ical:calendar-color>\(xmlEscape(color))</ical:calendar-color>
            </d:prop>
          </d:set>
        </d:propertyupdate>
        """
        let response = try await davRequest(
            method: "PROPPATCH",
            url: url,
            headers: ["Content-Type": "application/xml; charset=utf-8"],
            body: body,
            username: username,
            password: password
        )
        guard [200, 207].contains(response.statusCode) else {
            throw CalDAVError.serverError(response.statusCode, response.body)
        }
    }

    // MARK: - Private HTTP helpers

    private struct DAVResponse {
        var statusCode: Int
        var headers: [String: String]
        var body: String
        var finalURL: String?
    }

    private func davRequest(
        method: String,
        url: URL,
        headers: [String: String],
        body: String?,
        username: String,
        password: String
    ) async throws -> DAVResponse {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(basicAuth(username: username, password: password), forHTTPHeaderField: "Authorization")
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        if let body = body {
            request.httpBody = body.data(using: .utf8)
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw CalDAVError.networkError(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw CalDAVError.unexpectedResponse("Non-HTTP response")
        }

        if http.statusCode == 401 {
            throw CalDAVError.authenticationFailed(401)
        }

        var respHeaders: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            respHeaders["\(key)".lowercased()] = "\(value)"
        }

        let bodyText = String(data: data, encoding: .utf8) ?? ""
        return DAVResponse(statusCode: http.statusCode, headers: respHeaders, body: bodyText, finalURL: http.url?.absoluteString)
    }

    private func basicAuth(username: String, password: String) -> String {
        let raw = "\(username):\(password)"
        guard let data = raw.data(using: .utf8) else { return "" }
        return "Basic \(data.base64EncodedString())"
    }

    private func fetchSyncToken(collectionURL: String, username: String, password: String) async throws -> String? {
        guard let url = URL(string: collectionURL) else { return nil }
        let body = """
        <?xml version="1.0" encoding="UTF-8"?>
        <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
          <d:prop>
            <d:sync-token/>
            <cs:getctag/>
          </d:prop>
        </d:propfind>
        """
        let response = try await davRequest(
            method: "PROPFIND",
            url: url,
            headers: ["Depth": "0", "Content-Type": "application/xml; charset=utf-8"],
            body: body,
            username: username,
            password: password
        )
        return xmlTextContent(response.body, localName: "sync-token")
            ?? xmlTextContent(response.body, localName: "getctag")
    }

    // MARK: - XML parsing helpers

    private func parseCollections(from xml: String, baseURL: String) -> [DiscoveredCollection] {
        guard let data = xml.data(using: .utf8) else { return [] }
        let parser = MultiStatusParser(data: data)
        guard parser.parse() else { return [] }

        return parser.responses.compactMap { resp -> DiscoveredCollection? in
            // Only include calendar resources
            guard resp.properties["resourcetype"]?.contains("calendar") == true else { return nil }
            let supportsVTODO = resp.properties["supported-calendar-component-set"]?.contains("VTODO") ?? true
            return DiscoveredCollection(
                url: resolveURL(resp.href, base: baseURL),
                displayName: resp.properties["displayname"] ?? "",
                description: resp.properties["calendar-description"],
                color: resp.properties["calendar-color"],
                ctag: resp.properties["getctag"],
                syncToken: resp.properties["sync-token"],
                supportsVTODO: supportsVTODO
            )
        }
    }

    private func parseCalendarDataResponses(from xml: String) -> [FetchedVTODO] {
        guard let data = xml.data(using: .utf8) else { return [] }
        let parser = MultiStatusParser(data: data)
        guard parser.parse() else { return [] }

        return parser.responses.compactMap { resp -> FetchedVTODO? in
            guard let icsData = resp.properties["calendar-data"], !icsData.isEmpty else { return nil }
            return FetchedVTODO(
                url: resp.href,
                etag: resp.properties["getetag"],
                icsData: icsData
            )
        }
    }

    private func xmlPropertyHref(_ xml: String, localName: String) -> String? {
        guard let data = xml.data(using: .utf8) else { return nil }
        let parser = SimpleXMLFinder(data: data, targetLocalName: localName)
        parser.parse()
        return parser.foundHref
    }

    private func xmlTextContent(_ xml: String, localName: String) -> String? {
        guard let data = xml.data(using: .utf8) else { return nil }
        let parser = SimpleXMLFinder(data: data, targetLocalName: localName)
        parser.parse()
        return parser.foundText
    }

    private func resolveURL(_ href: String, base: String) -> String {
        if href.hasPrefix("http://") || href.hasPrefix("https://") { return href }
        guard let baseURL = URL(string: base),
              let resolved = URL(string: href, relativeTo: baseURL) else { return href }
        return resolved.absoluteString
    }

    private func xmlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
         .replacingOccurrences(of: "\"", with: "&quot;")
         .replacingOccurrences(of: "'", with: "&apos;")
    }
}

// MARK: - Multi-status XML Parser

private struct ResponseEntry {
    var href: String
    var statusCode: Int
    var properties: [String: String]
}

private class MultiStatusParser: NSObject, XMLParserDelegate {
    private let data: Data
    var responses: [ResponseEntry] = []

    private var currentHref: String?
    private var currentStatus: Int = 200
    private var currentProperties: [String: String] = [:]
    private var currentText = ""
    private var elementStack: [String] = []
    private var inPropstat = false
    private var propstatStatus = 200
    private var inProp = false
    private var propDepth = 0
    private var inResourceType = false
    private var resourceTypeValue = ""
    private var inCompSet = false
    private var compSetValue = ""

    init(data: Data) {
        self.data = data
    }

    func parse() -> Bool {
        let xmlParser = XMLParser(data: data)
        xmlParser.delegate = self
        return xmlParser.parse()
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName: String?, attributes attributeDict: [String: String] = [:]) {
        let local = elementName.components(separatedBy: ":").last ?? elementName
        elementStack.append(local)
        currentText = ""

        switch local {
        case "response":
            currentHref = nil
            currentStatus = 200
            currentProperties = [:]
        case "propstat":
            inPropstat = true
            propstatStatus = 200
        case "prop":
            if inPropstat { inProp = true; propDepth = 0 }
        case "resourcetype":
            if inProp { inResourceType = true; resourceTypeValue = "" }
        case "calendar":
            if inResourceType { resourceTypeValue += "calendar" }
        case "supported-calendar-component-set":
            if inProp { inCompSet = true; compSetValue = "" }
        case "comp":
            if inCompSet { compSetValue += attributeDict["name"] ?? "" }
        default:
            break
        }
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName: String?) {
        let local = elementName.components(separatedBy: ":").last ?? elementName
        let text = currentText.trimmingCharacters(in: .whitespacesAndNewlines)

        switch local {
        case "href":
            if !inPropstat { currentHref = text }
        case "status":
            if inPropstat {
                propstatStatus = parseHTTPStatus(text)
            }
        case "propstat":
            inPropstat = false
            inProp = false
        case "prop":
            inProp = false
        case "response":
            if let href = currentHref {
                responses.append(ResponseEntry(href: href, statusCode: currentStatus, properties: currentProperties))
            }
        case "resourcetype":
            if inProp {
                currentProperties["resourcetype"] = resourceTypeValue
                inResourceType = false
            }
        case "supported-calendar-component-set":
            if inProp {
                currentProperties["supported-calendar-component-set"] = compSetValue
                inCompSet = false
            }
        default:
            if inProp && propstatStatus == 200 {
                currentProperties[local] = text
            }
        }

        _ = elementStack.popLast()
        currentText = ""
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        currentText += string
    }

    private func parseHTTPStatus(_ statusLine: String) -> Int {
        let parts = statusLine.split(separator: " ")
        guard parts.count >= 2, let code = Int(parts[1]) else { return 200 }
        return code
    }
}

// MARK: - Simple property finder

private class SimpleXMLFinder: NSObject, XMLParserDelegate {
    private let data: Data
    private let targetLocalName: String

    var foundHref: String?
    var foundText: String?
    private var inTarget = false
    private var inHref = false
    private var currentText = ""

    init(data: Data, targetLocalName: String) {
        self.data = data
        self.targetLocalName = targetLocalName
    }

    func parse() {
        let xmlParser = XMLParser(data: data)
        xmlParser.delegate = self
        xmlParser.parse()
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName: String?, attributes attributeDict: [String: String] = [:]) {
        let local = elementName.components(separatedBy: ":").last ?? elementName
        currentText = ""
        if local.lowercased() == targetLocalName.lowercased() { inTarget = true }
        if inTarget && local == "href" { inHref = true }
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName: String?) {
        let local = elementName.components(separatedBy: ":").last ?? elementName
        let text = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        if inTarget && local == "href" {
            foundHref = text
            inHref = false
        }
        if local.lowercased() == targetLocalName.lowercased() && inTarget {
            if foundHref == nil && foundText == nil {
                foundText = text.isEmpty ? nil : text
            }
            inTarget = false
        }
        currentText = ""
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        currentText += string
    }
}

// MARK: - String extension

extension String {
    func ensureTrailingSlash() -> String {
        hasSuffix("/") ? self : self + "/"
    }
}
