#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
DRY_RUN=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--yes]" >&2
      exit 1
      ;;
  esac
done

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

propfind() {
  local url="$1"
  local depth="$2"
  local body="$3"

  curl -sS \
    -X PROPFIND "$url" \
    -H "Authorization: $AUTH_HEADER" \
    -H "Depth: $depth" \
    -H 'Content-Type: application/xml; charset=utf-8' \
    --data-binary "$body"
}

delete_collection() {
  local url="$1"
  curl -sS -o /tmp/tmw-delete-body.$$ -w '%{http_code}' \
    -X DELETE "$url" \
    -H "Authorization: $AUTH_HEADER"
}

resolve_url() {
  local base="$1"
  local href="$2"

  if [[ "$href" =~ ^https?:// ]]; then
    printf '%s\n' "$href"
    return
  fi

  local origin
  origin="$(printf '%s\n' "$base" | sed -E 's#^(https?://[^/]+).*$#\1#')"

  if [[ "$href" == /* ]]; then
    printf '%s%s\n' "$origin" "$href"
    return
  fi

  printf '%s/%s\n' "${base%/}" "$href"
}

extract_property_href() {
  local property="$1"
  perl -0ne "if (m{<[^:>]*:?${property}\\b[^>]*>.*?<[^:>]*:?href\\b[^>]*>([^<]+)</[^>]*:?href>}is) { print \$1 }"
}

ROOT_PROPFIND_BODY='<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <d:current-user-principal />
    <c:calendar-home-set />
  </d:prop>
</d:propfind>'

PRINCIPAL_PROPFIND_BODY='<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <c:calendar-home-set />
  </d:prop>
</d:propfind>'

LIST_PROPFIND_BODY='<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
    <c:supported-calendar-component-set />
  </d:prop>
</d:propfind>'

root_base_url="$API_HOST/"
root_xml="$(propfind "$root_base_url" "0" "$ROOT_PROPFIND_BODY")"
principal_href="$(printf '%s' "$root_xml" | extract_property_href 'current-user-principal')"

if [[ -z "$principal_href" ]]; then
  root_base_url="$API_HOST/caldav/"
  root_xml="$(propfind "$root_base_url" "0" "$ROOT_PROPFIND_BODY")"
  principal_href="$(printf '%s' "$root_xml" | extract_property_href 'current-user-principal')"
fi

if [[ -z "$principal_href" ]]; then
  echo "Could not discover current-user-principal from $API_HOST/" >&2
  exit 1
fi

principal_url="$(resolve_url "$root_base_url" "$principal_href")"
principal_xml="$(propfind "$principal_url" "0" "$PRINCIPAL_PROPFIND_BODY")"
home_set_href="$(printf '%s' "$principal_xml" | extract_property_href 'calendar-home-set')"

if [[ -z "$home_set_href" ]]; then
  echo "Could not discover calendar-home-set from $principal_url" >&2
  exit 1
fi

home_set_url="$(resolve_url "$principal_url" "$home_set_href")"
home_set_xml="$(propfind "$home_set_url" "1" "$LIST_PROPFIND_BODY")"

mapfile -t collections < <(
  HOME_SET_URL="$home_set_url" perl -0ne '
    my $home = $ENV{HOME_SET_URL};
    while (m{<[^:>]*:?response\b[^>]*>(.*?)</[^:>]*:?response>}sg) {
      my $response = $1;
      next unless $response =~ m{<[^:>]*:?status\b[^>]*>HTTP/\S+\s+200\b}i;
      next unless $response =~ m{<[^:>]*:?calendar\b}i;
      my ($href) = $response =~ m{<[^:>]*:?href\b[^>]*>([^<]+)</[^:>]*:?href>}i;
      next unless defined $href;
      next if $href eq q{} || $href eq q{/};
      next if $home =~ m{\Q$href\E/?$};
      my ($displayname) = $response =~ m{<[^:>]*:?displayname\b[^>]*>([^<]*)</[^:>]*:?displayname>}i;
      $displayname //= q{};
      my @components = ($response =~ m{<[^:>]*:?comp\b[^>]*name="([^"]+)"}ig);
      print join("\t", $href, $displayname, join(",", @components)), "\n";
    }
  ' <<<"$home_set_xml"
)

if [[ ${#collections[@]} -eq 0 ]]; then
  echo "No calendars or reminder collections found under $home_set_url"
  exit 0
fi

echo "Discovered collections under $home_set_url:"
declare -a collection_urls=()
for entry in "${collections[@]}"; do
  IFS=$'\t' read -r href displayname components <<<"$entry"
  absolute_url="$(resolve_url "$home_set_url" "$href")"
  collection_urls+=("$absolute_url")
  label="${displayname:-<no displayname>}"
  comp_label="${components:-unknown}"
  printf ' - %s [%s]\n   %s\n' "$label" "$comp_label" "$absolute_url"
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "Dry run only. No collections were deleted."
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  read -r -p "Type DELETE to remove all listed calendars/reminders: " confirmation
  if [[ "$confirmation" != "DELETE" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo
failures=0
for collection_url in "${collection_urls[@]}"; do
  status="$(delete_collection "$collection_url")"
  if [[ "$status" =~ ^(200|202|204|404)$ ]]; then
    printf 'Deleted: %s (HTTP %s)\n' "$collection_url" "$status"
  else
    printf 'Failed:  %s (HTTP %s)\n' "$collection_url" "$status" >&2
    if [[ -f /tmp/tmw-delete-body.$$ ]]; then
      cat /tmp/tmw-delete-body.$$ >&2
      echo >&2
    fi
    failures=$((failures + 1))
  fi
done

rm -f /tmp/tmw-delete-body.$$

if [[ "$failures" -gt 0 ]]; then
  echo "Completed with $failures deletion failure(s)." >&2
  exit 1
fi

echo "All discovered calendars/reminders deleted."
