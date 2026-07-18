#!/usr/bin/env bash
# Post-deploy reachability check for health.yiin.lt.
#
# The site binds only the tailnet (host Caddy, tailscale node "health",
# 100.66.69.34). When the app is down Caddy still answers an EMPTY HTTP 200,
# so a status-only check proves nothing — this script fails unless the
# tailnet path returns a real, non-empty HTML page.
#
# Usage (from the VPS or any tailnet client):
#   scripts/verify-deploy.sh        # or: npm run verify:deploy
#
# Optional env:
#   HEALTH_URL          default https://health.yiin.lt/
#   HEALTH_RESOLVE_IP   default 100.66.69.34
#   BASIC_AUTH_USER / BASIC_AUTH_PASS   forwarded to curl when both are set

set -euo pipefail

url="${HEALTH_URL:-https://health.yiin.lt/}"
resolve_ip="${HEALTH_RESOLVE_IP:-100.66.69.34}"

host="${url#*://}" # strip scheme
host="${host%%/*}" # strip path
host="${host%%:*}" # strip port

curl_args=(--silent --show-error --max-time 20 --resolve "$host:443:$resolve_ip")
if [[ -n "${BASIC_AUTH_USER:-}" && -n "${BASIC_AUTH_PASS:-}" ]]; then
  curl_args+=(--user "$BASIC_AUTH_USER:$BASIC_AUTH_PASS")
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

fail() {
  echo "verify-deploy: FAIL — $*" >&2
  echo "hint: on the VPS, check the app directly:" >&2
  echo "  curl -sS http://127.0.0.1:3100/api/health   # expect {\"ok\":true}" >&2
  echo "then inspect 'docker ps' and the Coolify deployment logs." >&2
  exit 1
}

if ! code="$(curl --output "$body" --write-out '%{http_code}' "${curl_args[@]}" "$url")"; then
  fail "curl could not reach $url via $resolve_ip"
fi

[[ "$code" == "200" ]] || fail "$url returned HTTP $code (expected 200)"
[[ -s "$body" ]] || fail "$url returned an EMPTY 200 — the app is down and Caddy is answering in its place"
grep -qi '<html' "$body" || fail "$url returned HTTP $code but no <html tag — this is not the app"

echo "verify-deploy: OK — $url → HTTP $code, $(wc -c <"$body" | tr -d ' ') bytes of HTML"
