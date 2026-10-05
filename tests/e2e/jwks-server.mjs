// A stand-in for Cloudflare Access's signing-key endpoint, used ONLY by the end-to-end tests.
//
// Generates a throw-away RSA key pair at start-up (nothing is committed), serves the PUBLIC key as a JWKS on
// /cdn-cgi/access/certs, and writes the private key to a file so the test process can sign tokens the app will
// accept. The app under test is pointed here with CF_ACCESS_CERTS_URL (a test-only setting that the environment
// validation refuses in staging and production).
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair } from "jose";

const port = Number(process.env.E2E_JWKS_PORT ?? 3199);
// In the OS temp directory (not test-results/, which CI uploads as an artifact on failure).
const keyFile = process.env.E2E_ACCESS_KEY_FILE ?? path.join(tmpdir(), "leadgen-e2e-access-key.json");

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const kid = `e2e-${Date.now()}`;
const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
mkdirSync(path.dirname(keyFile), { recursive: true });
writeFileSync(keyFile, JSON.stringify({ kid, privateJwk: await exportJWK(privateKey) }), { mode: 0o600 });

createServer((request, response) => {
  if (request.url === "/cdn-cgi/access/certs") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  } else {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`e2e access key server on ${port}`));
