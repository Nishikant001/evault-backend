#!/usr/bin/env bash
# deploy/smoke-test.sh
#
# PRODUCTION DEPLOYMENT — post-deploy smoke test.
#
# MANUAL STEP to run (not wired into CI here): after DNS + SSL + Nginx +
# app are all live, run:
#   BASE_DOMAIN=app.mydms.com ./deploy/smoke-test.sh acme tcs
#
# This only checks that the wildcard routing / TLS / health layers are
# actually working end to end. It does NOT log in or exercise
# authenticated flows (documents, approvals, subscriptions, etc.) — that
# needs real tenant credentials and is intentionally left to your own
# Postman/Newman/API test suite. See DEPLOYMENT.md "Final test" for the
# full authenticated checklist this script does not cover.
set -euo pipefail

BASE_DOMAIN="${BASE_DOMAIN:?Set BASE_DOMAIN, e.g. app.mydms.com}"
TENANTS=("$@")
if [ ${#TENANTS[@]} -eq 0 ]; then
  TENANTS=("acme" "tcs")
fi

pass=0
fail=0

check() {
  local desc="$1"; shift
  if "$@" >/tmp/smoke_out 2>&1; then
    echo "✅ PASS: $desc"
    pass=$((pass+1))
  else
    echo "❌ FAIL: $desc"
    cat /tmp/smoke_out
    fail=$((fail+1))
  fi
}

echo "== Apex health check =="
check "GET https://${BASE_DOMAIN}/health returns 200" \
  bash -c "curl -fsS --max-time 10 https://${BASE_DOMAIN}/health | grep -q '\"status\":\"ok\"'"

echo
echo "== Known tenants resolve =="
for t in "${TENANTS[@]}"; do
  check "GET https://${t}.${BASE_DOMAIN}/health/tenant returns 200" \
    bash -c "curl -fsS --max-time 10 https://${t}.${BASE_DOMAIN}/health/tenant | grep -q '\"status\":\"ok\"'"
done

echo
echo "== Unknown tenant is rejected, not silently served =="
check "GET https://unknown-$$.${BASE_DOMAIN}/api/documents returns 404" \
  bash -c "code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://unknown-$$.${BASE_DOMAIN}/api/documents); [ \"\$code\" = '404' ]"

echo
echo "== TLS certificate covers the wildcard =="
check "certificate subject matches *.${BASE_DOMAIN}" \
  bash -c "echo | openssl s_client -connect ${TENANTS[0]}.${BASE_DOMAIN}:443 -servername ${TENANTS[0]}.${BASE_DOMAIN} 2>/dev/null | openssl x509 -noout -text | grep -q '${BASE_DOMAIN#*.}'"

echo
echo "== HTTP redirects to HTTPS =="
check "http:// apex redirects (301/308)" \
  bash -c "code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://${BASE_DOMAIN}/); [ \"\$code\" = '301' ] || [ \"\$code\" = '308' ]"

echo
echo "======================================="
echo "  Passed: $pass   Failed: $fail"
echo "======================================="
[ "$fail" -eq 0 ]
