# PQ Verifiable Archive

Post-quantum tamper-evidence for any signed document. Anchor a SHA-256 hash to Algorand mainnet and get back a self-contained proof bundle signed with ML-DSA-65 (NIST FIPS-204). Anyone can verify it later with the open-source verifier: the signature, document hash and Merkle proof check offline against a pinned issuer key, and the anchor is confirmed against any archival Algorand indexer.

Works with any signing tool: DocuSign, HelloSign, Adobe Sign, or a plain PDF. You bring the signed document; this adds the quantum-resistant notarization layer.

**Live on Algorand mainnet.** Real transactions, real ML-DSA-65 signatures, working open-source verifier.

## Try it in 2 minutes

1. Open **https://pq-verifiable-archive.vercel.app** → **Verify Independently** → **Load sample bundle & PDF**, then **Verify**. Everything runs in your browser against the public Algorand indexer; the PDF is never uploaded.
2. Change one character of the demo PDF (or use any other PDF) with the same bundle: the result flips to **INVALID** on the document-hash check.
3. Prefer a terminal? `git clone` this repo, `npm install`, then `npm run verify -- --bundle bundles/sample-contract-bundle.json --pdf assets/sample-contract.pdf`.

Anchoring a new document costs $0.01 USDC via x402 (`POST /api/anchor`, see below). Verifying is always free.

## Why this exists

Today's e-signature platforms use RSA or ECDSA. Both are broken by a large-enough quantum computer. NIST finalized ML-DSA (FIPS-204) in 2024 and CNSA 2.0 mandates PQC migration in federal procurement by ~2030–2035. Documents signed today need to be verifiable in 2040.

## What's different

| Property | DocuSign / Adobe Sign | PQ Verifiable Archive |
|---|---|---|
| Post-quantum issuer signature | No (RSA / ECDSA) | Yes — ML-DSA-65 (FIPS-204) |
| Verifiable without the vendor's servers | No | Yes — 3 checks offline (with a pinned key fingerprint), anchor check via any archival Algorand indexer |
| Issuer pinning | Platform CA | Verifier pins the issuer's Algorand address and key fingerprint |
| Data on-chain | n/a | Hashes only (pseudonymous — see [compliance FAQ](docs/compliance-faq.md)) |
| Works with any signer | No | Yes — bring any signed PDF |
| Standards | RSA / ECDSA | NIST FIPS-204, SHA-256, JCS (RFC 8785), RFC 6962-style Merkle tree |

**What the verifier does not do yet:** it does not verify Algorand's Falcon-512 state proofs. It trusts the indexer's report of the anchor transaction (after checking sender, round and note) and only reports state-proof coverage as information.

## Use as an MCP tool (AI agents)

Add to `claude_desktop_config.json` or `.claude/settings.json`:

```json
{
  "mcpServers": {
    "pq-verifiable-archive": {
      "command": "npx",
      "args": ["tsx", "/path/to/pq-verifiable-archive/src/mcp-server.ts"],
      "env": {
        "ALGORAND_MNEMONIC": "your 25-word mnemonic",
        "PQVA_MLDSA_PUBLIC_KEY": "hex-encoded ML-DSA-65 public key",
        "PQVA_MLDSA_PRIVATE_KEY": "hex-encoded ML-DSA-65 private key",
        "PQVA_KEY_REGISTRATION_TXN_ID": "algorand txn id from npm run register-key"
      }
    }
  }
}
```

Claude (or any MCP-compatible agent) can then call:
- `anchor_document` — anchor a SHA-256 hash to Algorand, receive a proof bundle (capped at `MCP_MAX_ANCHORS_PER_DAY`, default 25)
- `verify_bundle` — verify a bundle against the trusted issuer (`PQVA_TRUSTED_*`, default: the hosted service)

Signers passed to `anchor_document` or the REST API are recorded as `requester-asserted`: the bundle proves you claimed them, not that they signed.

**Self-hosted MCP is free.** You pay only Algorand's network fee (~$0.0002 per anchor).

## Hosted API (pay-per-use)

If you don't want to run your own node, call the hosted REST endpoint:

```bash
# Without payment — returns 402 with payment instructions
curl -X POST https://pq-verifiable-archive.vercel.app/api/anchor \
  -H "Content-Type: application/json" \
  -d '{"hash":"<sha256 hex>","envelope_id":"contract-001"}'

# With x402 payment ($0.01 USDC on Algorand)
curl -X POST https://pq-verifiable-archive.vercel.app/api/anchor \
  -H "Content-Type: application/json" \
  -H "payment-signature: <x402 payment header>" \
  -d '{"hash":"<sha256 hex>","envelope_id":"contract-001"}'
```

Price: **$0.01 per anchor.** Verification is always free.

**OpenAPI spec:** [`/openapi.json`](https://pq-verifiable-archive.vercel.app/openapi.json) — machine-readable for LLMs, tools, and code generators.

## Self-hosted quick start

```bash
git clone https://github.com/m-reynaldo35/pq-verifiable-archive.git
cd pq-verifiable-archive
npm install
cp .env.example .env   # fill in ALGORAND_MNEMONIC + ML-DSA keys
npm run generate-wallet   # or use existing wallet
npm run register-key      # registers your ML-DSA-65 key on Algorand
npm run dev               # HTTP server on :3000
npm run mcp               # MCP server (stdio) for AI agents
```

Generate a sample document and verify it:

```bash
npx tsx scripts/generate-sample-pdf.ts
npm run verify -- --bundle bundles/sample-contract-bundle.json --pdf assets/sample-contract.pdf
```

Required env vars (see `.env.example`): `ALGORAND_MNEMONIC`, `PQVA_MLDSA_PUBLIC_KEY`,
`PQVA_MLDSA_PRIVATE_KEY`, `PQVA_KEY_REGISTRATION_TXN_ID` (the old `DOCUSIGN_*` names
still work but are deprecated).

With `NODE_ENV=production` the server also requires `PORTAL_API_KEY` (operator
archive UI and `/api/documents`) and `X402_TREASURY_ADDRESS` (pay-per-anchor); without
them every request returns 503. Locally the archive is stored in `PQVA_ARCHIVE_DIR`
(default `./archive`).

Verifying your own bundles: pass your issuer to the verifier, e.g.
`npm run verify -- --bundle b.json --pdf doc.pdf --issuer-address <addr> --key-reg-txn <txid> --pk-sha256 <hex>`
(`npm run register-key` prints these values).

## Deploy to Vercel

The app runs on Vercel as one serverless function (`api/index.ts`) with `public/` served from the CDN (see `vercel.json`).

1. Import the repository as a Vercel project (framework preset: Other; no build command needed).
2. **Storage:** create a **private** Blob store and connect it to the project (this sets `BLOB_READ_WRITE_TOKEN`). It stores archived PDFs and bundles plus the payment and webhook claims.
3. **Environment variables** (Production): `ALGORAND_MNEMONIC`, `PQVA_MLDSA_PUBLIC_KEY`, `PQVA_MLDSA_PRIVATE_KEY`, `PQVA_KEY_REGISTRATION_TXN_ID`, `PORTAL_API_KEY`, `X402_TREASURY_ADDRESS`, and for DocuSign `DOCUSIGN_HMAC_KEY` plus the `DOCUSIGN_*` API credentials. Mark the secrets as Sensitive.
4. Optional: add a Vercel Firewall rate-limit rule for `/api/anchor` and `/api/verify`. The in-app limits apply per function instance only.

If anything required is missing in production, every request returns 503 and the reason appears in the function logs.

## How verification works

The verifier (`npm run verify`) exits `0` = VALID, `1` = INVALID, `2` = could not verify. Without `--pdf` it prints `BUNDLE VALID — document not checked`. By default it trusts the hosted service's issuer and says so; use `--issuer-address`/`--key-reg-txn`/`--pk-sha256` for any other issuer. It does not read `.env`.

| Step | Check | Network |
|---|---|---|
| 1 | ML-DSA-65 signature, and the key belongs to the trusted issuer (pinned fingerprint, or a key-registration txn sent by the issuer address). Fails closed. | None when the fingerprint is pinned |
| 2 | SHA-256(document) matches `documentHash` | None |
| 3 | Merkle proof from the document hash to the root | None |
| 4 | Anchor txn sent by the issuer, in the claimed round, with exactly this root in its note; ledger round time is the anchoring time | Algorand indexer |
| 5 | Informational: indexer lists a state-proof txn covering the round (not verified) | Algorand indexer |

## Who uses this

- **HR platforms** — offer letters, NDAs, termination agreements with quantum-proof audit trail
- **Legal tech** — tamper-evident contract archive that survives vendor shutdown
- **Healthcare** — patient consent forms (no names or content on-chain; hashes are pseudonymous, so assess under your own HIPAA/GDPR analysis)
- **AI agents** — autonomous agents executing agreements need immutable, verifiable receipts
- **Anyone signing documents today** that need to be verifiable in 2040

## Proof bundle (example)

```json
{
  "protocol": "pqva/2",
  "envelopeId": "launch-test-contract-001",
  "documentHash": "7ad4c3341e5c37b4bdc1001abbb3b99ecbb3ea42deca98ea7e6b7366805be991",
  "batchId": "5V47FZ65L4AO2UWOSEP73GGKGFYOQ672URVRE5F6GPGL3M7G6EHA",
  "merkleRoot": "170c1f67b7709e58...",
  "merkleProof": [],
  "algorandTxnId": "5V47FZ65L4AO2UWOSEP73GGKGFYOQ672URVRE5F6GPGL3M7G6EHA",
  "algorandRound": 65727529,
  "blockTimestamp": "2026-10-06T13:41:09.000Z",
  "stateProofRound": 65727744,
  "issuerAddress": "XCJOXAMHVPXGFJHHKF3CUSVD7CD44Z4FB3BFXZYH46HYX6NUQ7TANSWAMM",
  "keyRegistrationTxnId": "S7NGS2LDQXB73R4XSSOS6VRCS66ZL3I5S7FQWXHB4YIXLDISLZ7Q",
  "signers": [],
  "signerSource": "requester-asserted",
  "algorithm": "ml-dsa-65",
  "mldsaPublicKey": "...",
  "signature": "..."
}
```

This is a real bundle from a paid mainnet anchor ([explorer](https://explorer.perawallet.app/tx/5V47FZ65L4AO2UWOSEP73GGKGFYOQ672URVRE5F6GPGL3M7G6EHA)).

**Hosted issuers** (pinned in every verifier): `XCJOXAMH…` (current, key registration `S7NGS2LD…`) and `JJNDY3TL…` (original, key registration `BUVBKZAY…`).

Full schema: [`docs/architecture.md`](docs/architecture.md)

## Tech stack

| Component | Choice |
|---|---|
| Post-quantum signatures | `@noble/post-quantum` — ML-DSA-65 (NIST FIPS-204) |
| Blockchain | Algorand mainnet |
| AI agent interface | `@modelcontextprotocol/sdk` — MCP stdio server |
| Payments | `@x402-avm/express` — x402 on Algorand (GoPlausible) |
| Merkle trees | built in — SHA-256, RFC 6962-style leaf/node prefixes |
| Canonical JSON | `canonicalize` — JCS, RFC 8785 |
| Runtime | TypeScript + Node.js via `tsx` |

## License

MIT — free to use, self-host, and fork.
