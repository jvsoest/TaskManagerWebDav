#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${api_host:?api_host missing in .env}"
: "${username:?username missing in .env}"
: "${password:?password missing in .env}"

AUTH_HEADER="Basic $(printf '%s:%s' "$username" "$password" | base64 | tr -d '\n')"
API_HOST="${api_host%/}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$1"
}

resolve_url() {
  local base="$1"
  local href="$2"

  node - "$base" "$href" <<'EOF'
const [base, href] = process.argv.slice(2)
console.log(new URL(href, base).toString())
EOF
}

curl_dav() {
  local method="$1"
  local url="$2"
  local output="$3"
  local headers_file="$4"
  local body_file="${5:-}"
  if [[ $# -ge 5 ]]; then
    shift 5 || true
  else
    shift 4 || true
  fi

  local -a args=(
    -sS
    -D "$headers_file"
    -o "$output"
    -w '%{http_code}'
    -X "$method" "$url"
    -H "Authorization: $AUTH_HEADER"
  )

  if [[ $# -gt 0 ]]; then
    args+=("$@")
  fi

  if [[ -n "$body_file" ]]; then
    args+=(--data-binary "@$body_file")
  fi

  curl "${args[@]}"
}

extract_header() {
  local headers_file="$1"
  local name="$2"
  perl -ne 'if (/^\Q'"$name"'\E:\s*(.+?)\r?$/i) { print $1; exit }' "$headers_file"
}

extract_property_href() {
  local xml_file="$1"
  local property="$2"
  perl -0ne 'if (m{<[^:>]*:?'"$property"'\b[^>]*>.*?<[^:>]*:?href\b[^>]*>([^<]+)</[^>]*:?href>}is) { print $1 }' "$xml_file"
}

discover_root_base() {
  local root_body="$WORK_DIR/root-propfind.xml"
  cat >"$root_body" <<'EOF'
<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <d:current-user-principal />
    <c:calendar-home-set />
  </d:prop>
</d:propfind>
EOF

  for candidate in "$API_HOST/" "$API_HOST/caldav/"; do
    local out="$WORK_DIR/root.out"
    local headers="$WORK_DIR/root.headers"
    local status
    status="$(curl_dav PROPFIND "$candidate" "$out" "$headers" "$root_body" -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8')"
    if [[ "$status" == "207" ]] && [[ -n "$(extract_property_href "$out" 'current-user-principal')" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  echo "Could not discover CalDAV root base from $API_HOST/" >&2
  exit 1
}

discover_home_set() {
  local root_base="$1"
  local root_body="$WORK_DIR/root-propfind.xml"
  local root_out="$WORK_DIR/root.out"
  local root_headers="$WORK_DIR/root.headers"
  local principal_body="$WORK_DIR/principal-propfind.xml"
  local principal_out="$WORK_DIR/principal.out"
  local principal_headers="$WORK_DIR/principal.headers"

  cat >"$root_body" <<'EOF'
<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <d:current-user-principal />
    <c:calendar-home-set />
  </d:prop>
</d:propfind>
EOF

  cat >"$principal_body" <<'EOF'
<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <c:calendar-home-set />
  </d:prop>
</d:propfind>
EOF

  curl_dav PROPFIND "$root_base" "$root_out" "$root_headers" "$root_body" -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' >/dev/null
  local home_set_href
  home_set_href="$(extract_property_href "$root_out" 'calendar-home-set')"
  if [[ -n "$home_set_href" ]]; then
    resolve_url "$root_base" "$home_set_href"
    return
  fi

  local principal_href
  principal_href="$(extract_property_href "$root_out" 'current-user-principal')"
  if [[ -z "$principal_href" ]]; then
    echo "Could not discover current-user-principal from $root_base" >&2
    exit 1
  fi

  local principal_url
  principal_url="$(resolve_url "$root_base" "$principal_href")"
  curl_dav PROPFIND "$principal_url" "$principal_out" "$principal_headers" "$principal_body" -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' >/dev/null
  home_set_href="$(extract_property_href "$principal_out" 'calendar-home-set')"
  if [[ -z "$home_set_href" ]]; then
    echo "Could not discover calendar-home-set from $principal_url" >&2
    exit 1
  fi

  resolve_url "$principal_url" "$home_set_href"
}

list_home_set() {
  local home_set_url="$1"
  local body="$WORK_DIR/list-home-set.xml"
  local out="$WORK_DIR/list-home-set.out"
  local headers="$WORK_DIR/list-home-set.headers"

  cat >"$body" <<'EOF'
<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
    <c:supported-calendar-component-set />
  </d:prop>
</d:propfind>
EOF

  curl_dav PROPFIND "$home_set_url" "$out" "$headers" "$body" -H 'Depth: 1' -H 'Content-Type: application/xml; charset=utf-8' >/dev/null
  cat "$out"
}

pick_metadata_collection_url() {
  local home_set_xml="$1"
  local home_set_url="$2"

  perl -0ne '
    while (m{<[^:>]*:?response\b[^>]*>(.*?)</[^:>]*:?response>}sg) {
      my $response = $1;
      next unless $response =~ m{<[^:>]*:?displayname\b[^>]*>TaskManager Metadata</[^:>]*:?displayname>}i;
      next unless $response =~ m{<[^:>]*:?comp\b[^>]*name="VTODO"}i;
      my ($href) = $response =~ m{<[^:>]*:?href\b[^>]*>([^<]+)</[^:>]*:?href>}i;
      next unless defined $href;
      print $href, "\n";
    }
  ' <<<"$home_set_xml" | while IFS= read -r href; do
    [[ -z "$href" ]] && continue
    local absolute_url
    absolute_url="$(resolve_url "$home_set_url" "$href")"
    local body="$WORK_DIR/metadata-check.out"
    local headers="$WORK_DIR/metadata-check.headers"
    local propfind_body="$WORK_DIR/metadata-check.xml"
    cat >"$propfind_body" <<'EOF'
<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname />
  </d:prop>
</d:propfind>
EOF
    local status
    status="$(curl_dav PROPFIND "$absolute_url" "$body" "$headers" "$propfind_body" -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8')"
    if [[ "$status" != "404" ]]; then
      printf '%s\n' "$absolute_url"
      return 0
    fi
  done
}

create_vtodo_collection() {
  local home_set_url="$1"
  local slug="$2"
  local display_name="$3"
  local body="$WORK_DIR/mkcalendar.xml"
  local out="$WORK_DIR/mkcalendar.out"
  local headers="$WORK_DIR/mkcalendar.headers"
  local requested_url="${home_set_url%/}/${slug}/"

  cat >"$body" <<EOF
<?xml version="1.0" encoding="utf-8" ?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>${display_name}</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VTODO" />
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>
EOF

  local status
  status="$(curl_dav MKCALENDAR "$requested_url" "$out" "$headers" "$body" -H 'Content-Type: application/xml; charset=utf-8')"
  if [[ ! "$status" =~ ^(200|201|204|405)$ ]]; then
    echo "MKCALENDAR failed for $requested_url (HTTP $status)" >&2
    cat "$out" >&2
    exit 1
  fi

  local location
  location="$(extract_header "$headers" 'Location')"
  if [[ -n "$location" ]]; then
    resolve_url "$requested_url" "$location"
  else
    printf '%s\n' "$requested_url"
  fi
}

delete_collection_url() {
  local url="$1"
  local out="$WORK_DIR/delete.out"
  local headers="$WORK_DIR/delete.headers"
  local status
  status="$(curl_dav DELETE "$url" "$out" "$headers")"
  if [[ ! "$status" =~ ^(200|202|204|404)$ ]]; then
    echo "DELETE failed for $url (HTTP $status)" >&2
    cat "$out" >&2
    exit 1
  fi
}

report_collection() {
  local collection_url="$1"
  local out="$WORK_DIR/report.out"
  local headers="$WORK_DIR/report.headers"
  local body="$WORK_DIR/report.xml"

  cat >"$body" <<'EOF'
<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO" />
    </c:comp-filter>
  </c:filter>
</c:calendar-query>
EOF

  curl_dav REPORT "$collection_url" "$out" "$headers" "$body" -H 'Depth: 1' -H 'Content-Type: application/xml; charset=utf-8' >/dev/null
  cat "$out"
}

build_metadata_update() {
  local existing_json="$1"
  local folder_id="$2"
  local folder_name="$3"
  local now="$4"

  node - "$existing_json" "$folder_id" "$folder_name" "$now" <<'EOF'
const [existingJson, folderId, folderName, now] = process.argv.slice(2)
let doc
if (existingJson && existingJson !== '__EMPTY__') {
  doc = JSON.parse(existingJson)
} else {
  doc = {
    accountId: 'script-test',
    version: 1,
    folderNodes: [],
    tagNodes: [],
    collectionFolders: {},
    collectionOrder: [],
    taskListOrderings: {},
    manualTaskOrder: {},
    updatedAt: now,
  }
}
doc.folderNodes = Array.isArray(doc.folderNodes) ? doc.folderNodes : []
doc.tagNodes = Array.isArray(doc.tagNodes) ? doc.tagNodes : []
doc.collectionFolders = doc.collectionFolders ?? {}
doc.collectionOrder = Array.isArray(doc.collectionOrder) ? doc.collectionOrder : []
doc.taskListOrderings = doc.taskListOrderings ?? {}
doc.manualTaskOrder = doc.manualTaskOrder ?? {}
doc.folderNodes.push({
  id: folderId,
  accountId: doc.accountId || 'script-test',
  name: folderName,
})
doc.updatedAt = now
console.log(JSON.stringify(doc))
EOF
}

build_metadata_ics() {
  local json_payload="$1"
  local now="$2"
  node - "$json_payload" "$now" <<'EOF'
const [jsonPayload, now] = process.argv.slice(2)
const escapeIcs = (value) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
const formatIcsDate = (value) => new Date(value).toISOString().replace(/[-:]/g, '').replace('.000', '')
const lines = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//TaskManagerWebDav//EN',
  'BEGIN:VTODO',
  'UID:taskmanager-metadata',
  `DTSTAMP:${formatIcsDate(now)}`,
  'SUMMARY:TaskManager Metadata',
  `DESCRIPTION:${escapeIcs(jsonPayload)}`,
  'STATUS:NEEDS-ACTION',
  'PRIORITY:0',
  `CREATED:${formatIcsDate(now)}`,
  `LAST-MODIFIED:${formatIcsDate(now)}`,
  'END:VTODO',
  'END:VCALENDAR',
  '',
]
process.stdout.write(lines.join('\r\n'))
EOF
}

extract_metadata_state() {
  local report_xml="$1"
  perl -0ne '
    use MIME::Base64 qw(encode_base64);
    if (
      m{<[^:>]*:?response\b[^>]*>.*?<[^:>]*:?href\b[^>]*>([^<]*taskmanager-metadata\.ics)</[^>]*:?href>.*?<[^:>]*:?getetag\b[^>]*>([^<]+)</[^>]*:?getetag>.*?<[^:>]*:?calendar-data\b[^>]*>(.*?)</[^>]*:?calendar-data>}is
    ) {
      print "$1\t$2\t", encode_base64($3, q{});
    }
  ' <<<"$report_xml"
}

extract_metadata_json() {
  local calendar_data="$1"
  node - "$calendar_data" <<'EOF'
const [calendarData] = process.argv.slice(2)
const decodeEntities = (value) =>
  value
    .replace(/&#xD;/g, '\r')
    .replace(/&#xA;/g, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
const unescapeIcs = (value) =>
  value
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
const decoded = decodeEntities(calendarData).replace(/\r?\n[ \t]/g, '')
const match = decoded.match(/(?:^|\r?\n)DESCRIPTION:(.*?)(?:\r?\n[A-Z-]+[:;]|\r?\nEND:VTODO)/s)
if (!match) {
  process.stdout.write('__EMPTY__')
} else {
  process.stdout.write(unescapeIcs(match[1]).trim() || '__EMPTY__')
}
EOF
}

put_calendar_resource() {
  local url="$1"
  local etag="$2"
  local body_file="$3"
  local out="$WORK_DIR/put.out"
  local headers="$WORK_DIR/put.headers"
  local status
  if [[ -n "$etag" && "$etag" != "__NONE__" ]]; then
    status="$(curl_dav PUT "$url" "$out" "$headers" "$body_file" -H 'Content-Type: text/calendar; charset=utf-8' -H "If-Match: $etag")"
  else
    status="$(curl_dav PUT "$url" "$out" "$headers" "$body_file" -H 'Content-Type: text/calendar; charset=utf-8' -H 'If-None-Match: *')"
  fi

  if [[ ! "$status" =~ ^(200|201|204)$ ]]; then
    echo "PUT failed for $url (HTTP $status)" >&2
    cat "$out" >&2
    exit 1
  fi
}

main() {
  log "Discovering Cirrux CalDAV home set"
  local root_base
  root_base="$(discover_root_base)"
  local home_set_url
  home_set_url="$(discover_home_set "$root_base")"
  printf 'Home set: %s\n' "$home_set_url"

  log "Testing list creation and deletion"
  local unique
  unique="$(date +%s)-$$"
  local list_url
  list_url="$(create_vtodo_collection "$home_set_url" "tmw-list-test-$unique" "TMW List Test $unique")"
  printf 'Created list at: %s\n' "$list_url"
  delete_collection_url "$list_url"
  printf 'Deleted list at: %s\n' "$list_url"

  log "Testing folder add/remove through metadata"
  local home_set_xml
  home_set_xml="$(list_home_set "$home_set_url")"
  local metadata_collection_url
  metadata_collection_url="$(pick_metadata_collection_url "$home_set_xml" "$home_set_url" || true)"
  local created_metadata_collection=0
  if [[ -z "$metadata_collection_url" ]]; then
    metadata_collection_url="$(create_vtodo_collection "$home_set_url" "tmw-meta-test-$unique" 'TaskManager Metadata')"
    created_metadata_collection=1
    printf 'Created metadata collection at: %s\n' "$metadata_collection_url"
  else
    printf 'Using metadata collection: %s\n' "$metadata_collection_url"
  fi

  local report_before
  report_before="$(report_collection "$metadata_collection_url")"
  local metadata_state
  metadata_state="$(extract_metadata_state "$report_before")"

  local metadata_href='' metadata_etag='__NONE__' metadata_calendar_data_b64=''
  if [[ -n "$metadata_state" ]]; then
    IFS=$'\t' read -r metadata_href metadata_etag metadata_calendar_data_b64 <<<"$metadata_state"
  fi

  local metadata_url
  if [[ -n "$metadata_href" ]]; then
    metadata_url="$(resolve_url "$metadata_collection_url" "$metadata_href")"
  else
    metadata_url="${metadata_collection_url%/}/taskmanager-metadata.ics"
  fi

  local original_json='__EMPTY__'
  if [[ -n "$metadata_calendar_data_b64" ]]; then
    original_json="$(extract_metadata_json "$(printf '%s' "$metadata_calendar_data_b64" | base64 --decode)")"
  fi

  local folder_id="script-folder-$unique"
  local folder_name="Script Folder $unique"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local updated_json
  updated_json="$(build_metadata_update "$original_json" "$folder_id" "$folder_name" "$now")"
  local updated_ics="$WORK_DIR/updated-metadata.ics"
  build_metadata_ics "$updated_json" "$now" >"$updated_ics"
  put_calendar_resource "$metadata_url" "$metadata_etag" "$updated_ics"

  local report_after
  report_after="$(report_collection "$metadata_collection_url")"
  local report_after_state
  report_after_state="$(extract_metadata_state "$report_after")"
  local report_after_calendar_data_b64=''
  if [[ -n "$report_after_state" ]]; then
    IFS=$'\t' read -r _ _ report_after_calendar_data_b64 <<<"$report_after_state"
  fi
  local report_after_json='__EMPTY__'
  if [[ -n "$report_after_calendar_data_b64" ]]; then
    report_after_json="$(extract_metadata_json "$(printf '%s' "$report_after_calendar_data_b64" | base64 --decode)")"
  fi
  if ! grep -q "$folder_id" <<<"$report_after_json"; then
    echo "Folder test failed: $folder_name not found in metadata after update." >&2
    exit 1
  fi
  printf 'Added folder marker: %s\n' "$folder_name"

  local reverted_ics="$WORK_DIR/reverted-metadata.ics"
  if [[ "$original_json" == "__EMPTY__" ]]; then
    delete_collection_url "$metadata_url"
  else
    local revert_state
    revert_state="$(extract_metadata_state "$report_after")"
    local current_etag='__NONE__'
    if [[ -n "$revert_state" ]]; then
      IFS=$'\t' read -r _ current_etag _ <<<"$revert_state"
    fi
    build_metadata_ics "$original_json" "$now" >"$reverted_ics"
    put_calendar_resource "$metadata_url" "$current_etag" "$reverted_ics"
  fi
  printf 'Reverted folder metadata change.\n'

  if [[ "$created_metadata_collection" -eq 1 ]]; then
    delete_collection_url "$metadata_collection_url"
    printf 'Deleted temporary metadata collection: %s\n' "$metadata_collection_url"
  fi

  log "List and folder tests completed successfully"
}

main "$@"
