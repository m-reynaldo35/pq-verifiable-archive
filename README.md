# PQ Verifiable Archive

Post-quantum tamper-evidence for any signed document. Anchor a SHA-256 hash to Algorand mainnet and get back a self-contained proof bundle signed with ML-DSA-65 (NIST FIPS-204). Anyone can verify it later with the open-source verifier: the signature, document hash and Merkle proof check offline against a pinned issuer key, and the anchor is confirmed against any archival Algorand indexer.

Works with any signing tool: DocuSign, HelloSign, Adobe Sign, or a plain PDF. You bring the signed document; this adds the quantum-resistant notarization layer.

**Live on Algorand mainnet.** Real transactions, real ML-DSA-65 signatures, working open-source verifier.

## Try it in 2 minutes

**With DocuSign:** open **https://pq-verifiable-archive.vercel.app/try**, sign a demo contract (DocuSign sandbox, embedded signing, no email or account needed), and about 30 seconds later you get your archived copy, its proof bundle and a one-click verifier. The same page anchors the hash of any file for free.

**Verify only:**

1. Open **https://pq-verifiable-archive.vercel.app** → **Verify Independently** → **Load sample bundle & PDF**, then **Verify**. Everything runs in your browser against the public Algorand indexer; the PDF is never uploaded.
2. Change one character of the demo PDF (or use any other PDF) with the same bundle: the result flips to **INVALID** on the document-hash check.
3. Prefer a terminal? `git clone` this repo, `npm install`, then `npm run verify -- --bundle bundles/sample-contract-bundle.json --pdf assets/sample-contract.pdf`.

Anchoring through the API costs $0.01 USDC via x402 (`POST /api/anchor`, see below); the `/try` demo is free within a daily cap. Verifying is always free.

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

## DocuSign

### What it adds
DocuSign's own evidence (the certificate of completion and the PDF seal) is RSA-signed and checked through DocuSign or a PDF trust chain. This adds an independent record of the exact completed document: a SHA-256 hash anchored on a public ledger, inside a receipt signed with ML-DSA-65. Anyone can check it, now or in 2040, without DocuSign or this service.

### How it works
1. An envelope is completed. **DocuSign Connect** posts `envelope-completed` to `/webhook/docusign` (JSON, SIM, HMAC-signed).
2. The webhook checks the HMAC, then asks the eSignature REST API for the envelope's status and only continues if it is `completed`.
3. It downloads the combined PDF **with the certificate of completion** (`documents/combined?certificate=true`) and the recipients, then hashes the PDF.
4. The hash goes into a Merkle tree anchored in an Algorand transaction. The proof bundle (`pqva/2`) is signed with ML-DSA-65 and records the signers as `docusign-connect` plus a signed `capture` record (DocuSign's completion time and the archive time).
5. The PDF and bundle are archived, and the signer gets a private link (`/d/<token>`) to download both and verify.

Each delivery is idempotent (one claim per envelope across instances), a failure returns 5xx so Connect retries, and a document is never anchored twice.

### DocuSign regenerates PDFs on every download
Two downloads of the same completed envelope have **different SHA-256 hashes**: DocuSign rewrites the XMP dates, the PDF `/ID` and its `adbe.pkcs` seal each time. A proof over "the envelope" can therefore never be checked against a later download. The design answer: **the archived copy is the document of record**. The archive captures it once, seconds after completion; the signer link hands out those exact bytes; and the signed `capture` record shows when DocuSign completed the envelope and when the copy was taken. (Normalising the PDF before hashing was rejected: it widens what the proof does not cover and every future verifier would have to reproduce the normalisation.)

### What the proof shows, and what it does not
- **Shows:** this exact file existed no later than the anchor's ledger time; the trusted issuer signed a receipt for it with a post-quantum signature; the signer list and capture times are what DocuSign reported to the issuer.
- **Does not show:** who signed. Signer identity still rests on DocuSign's own records and audit trail. The capture times are reported by DocuSign and the issuer; only the ledger time is independent.
- **Not yet post-quantum end to end:** the Algorand transaction itself is Ed25519-signed. Algorand's state proofs (Falcon, post-quantum) attest the ledger history, but the verifier only reports them and does not check them yet.
- **On-chain:** hashes only. Envelope ids are hashed too. Names and emails appear only in the archived PDF and bundle, behind the private link.

### Why not just…
- **…an RFC 3161 timestamp?** A good complement, but the timestamp authority signs with RSA or ECDSA (quantum-exposed) and the proof is only as good as that authority's certificate chain staying trusted. Here the issuer signature is ML-DSA-65, and the anchor is on a public ledger that anyone can query with no certificate authority.
- **…DocuSign's certificate of completion?** It is included in the hashed PDF. On its own it is RSA-sealed, verified through DocuSign or a PDF trust chain, and regenerated on every download.
- **…Algorand?** About 0.001 ALGO per anchor (a fraction of a cent), ~3 s finality with no forks, and Falcon-based state proofs give a post-quantum path for the ledger history.

### Numbers from the live sandbox tests (2026-10-09)
| | |
|---|---|
| Envelope completed → anchored on mainnet | 24–26 s (two envelopes) |
| Connect delivery failures | 0 |
| Cost per anchor | one Algorand transaction, 0.001 ALGO |
| Verification | free: browser, CLI or `POST /api/verify` |

### Run it against your own DocuSign developer account
1. **Self-host** this repo (see below) with your own Algorand wallet and ML-DSA key (`npm run generate-wallet`, `npm run register-key`).
2. **Apps and Keys** in the DocuSign developer console: create an integration key, generate an RSA key pair, and add a redirect URI (any, e.g. `https://localhost`) for the one-time consent.
3. **Grant consent** once for JWT impersonation: open `https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<INTEGRATION_KEY>&redirect_uri=<REDIRECT_URI>` and accept.
4. **Connect**: Settings → Connect → Add configuration → Custom. URL: `https://<your-host>/webhook/docusign`; data format **REST v2.1 / JSON (SIM)**; event **Envelope Signed/Completed**; tick **Include HMAC signature** and create an HMAC key under Connect Keys; enable for all users.
5. **Environment**: `DOCUSIGN_SANDBOX=true`, `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID` (your API user id), `DOCUSIGN_ACCOUNT_ID` (API account id), `DOCUSIGN_PRIVATE_KEY` (the RSA private key PEM, base64-encoded) and `DOCUSIGN_HMAC_KEY`.
6. Send yourself an envelope and sign it. The function log shows one line per delivery, `[webhook] event=envelope-completed envelope=… outcome=anchored`, and the record appears under **Archived Documents** with a **Signer link** button.

Production accounts work the same with `DOCUSIGN_SANDBOX=false`; the regional REST host is read from the account's `base_uri`. To enable the `/try` demo on your instance, see `PQVA_DEMO_*` in `.env.example`.

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
