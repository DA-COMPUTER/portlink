#!/usr/bin/env node
/**
 * portlink-gencert — generate a self-signed TLS cert for use with portlink host --cert / --key
 * Usage: node gencert.js [--out ./certs]
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const outDir = process.argv[2] || '.';
fs.mkdirSync(outDir, { recursive: true });

const certFile = path.join(outDir, 'portlink.crt');
const keyFile  = path.join(outDir, 'portlink.key');

console.log('Generating self-signed TLS certificate…');

try {
  execSync(
    `openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
     -keyout "${keyFile}" -out "${certFile}" \
     -subj "/CN=portlink" \
     -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
    { stdio: 'pipe' }
  );
  console.log(`✓ Certificate: ${certFile}`);
  console.log(`✓ Key:         ${keyFile}`);
  console.log('');
  console.log('Start host with:');
  console.log(`  portlink host 3000 --cert ${certFile} --key ${keyFile}`);
  console.log('');
  console.log('Clients connect with:');
  console.log('  portlink join <host> --tls --no-verify');
} catch (e) {
  console.error('openssl not found. Install OpenSSL and retry, or provide your own cert/key files.');
  process.exit(1);
}
