#!/usr/bin/env bash
# Creates a self-signed certificate for localhost in certs/ (for HTTPS testing only).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout certs/local.key -out certs/local.crt
echo "Created certs/local.crt. Your browser will warn that the certificate is self-signed. That is expected for local testing."
