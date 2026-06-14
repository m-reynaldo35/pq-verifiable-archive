# PQ Verifiable Archive

Post-quantum tamper-evidence for any signed document. Anchor a SHA-256 hash to Algorand mainnet, get back a self-contained proof bundle signed with ML-DSA-65 (NIST FIPS-204) that anyone can verify offline — decades from now, without trusting any vendor.

Works with any signing tool: DocuSign, HelloSign, Adobe Sign, or a plain PDF. You bring the signed document; this adds the quantum-resistant notarization layer.

**Live on Algorand mainnet.** Real transactions, real ML-DSA-65 signatures, working offline verifier.

## Why this exists

Today's e-signature platforms use RSA or ECDSA. Both are broken by a large-enough quantum computer. NIST finalized ML-DSA (FIPS-204) in 2024 and CNSA 2.0 mandates PQC migration in federal procurement by ~2030–2035. Documents signed today need to be verifiable in 2040.

## What's different

| Property | DocuSign / Adobe Sign | PQ Verifiable Archive |
|---|---|---|
| Quantum-resistant | No (RSA / ECDSA) | Yes — ML-DSA-65 + Algorand Falcon-512 state proofs |
| Offline-verifiable | No — requires vendor servers | Yes — 3 of 5 checks need no network at all |
| Vendor-independent | No — trust the platform | Yes — verify against a public permissionless chain |
| PII on-chain | n/a | None — only irreversible SHA-256 hashes are anchored |
| Works with any signer | No | Yes — bring any signed PDF |
| Standards | RSA / ECDSA | NIST FIPS-204, SHA-256, JCS (RFC 8785) |

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
        "DOCUSIGN_MLDSA_PUBLIC_KEY": "hex-encoded ML-DSA-65 public key",
        "DOCUSIGN_MLDSA_PRIVATE_KEY": "hex-encoded ML-DSA-65 private key",
        "DOCUSIGN_KEY_REGISTRATION_TXN_ID": "algorand txn id from npm run register-key"
      }
    }
  }
}
```

Claude (or any MCP-compatible agent) can then call:
- `anchor_document` — anchor a SHA-256 hash to Algorand, receive a proof bundle
- `verify_bundle` — run all 5 post-quantum verification checks on any bundle

**Self-hosted MCP is free.** You pay only Algorand's network fee (~$0.0002 per anchor).

## Hosted API (pay-per-use)

If you don't want to run your own node, call the hosted REST endpoint:

```bash
# Without payment — returns 402 with payment instructions
curl -X POST https://your-host/api/anchor \
  -H "Content-Type: application/json" \
  -d '{"hash":"<sha256 hex>","envelope_id":"contract-001"}'

# With x402 payment ($0.01 USDC on Algorand)
curl -X POST https://your-host/api/anchor \
  -H "Content-Type: application/json" \
  -H "payment-signature: <x402 payment header>" \
  -d '{"hash":"<sha256 hex>","envelope_id":"contract-001"}'
```

Price: **$0.01 per anchor.** Verification is always free.

## Self-hosted quick start

```bash
git clone https://github.com/m-reynaldo35/pq-verifiable-archive.git
cd pq-verifiable-archive
npm install
cp .env.example .env   # fill in ALGORAND_MNEMONIC + ML-DSA keys
npm run generate-wallet   # or use existing wallet
npm run register-key      # registers your ML-DSA-65 key on Algorand
npm start                 # HTTP server on :3000
npm run mcp               # MCP server (stdio) for AI agents
```

Generate a sample document and verify it:

```bash
npx tsx scripts/generate-sample-pdf.ts
npm run verify -- --bundle bundles/sample-contract-bundle.json --pdf assets/sample-contract.pdf
```

Required env vars (see `.env.example`): `ALGORAND_MNEMONIC`, `DOCUSIGN_MLDSA_PUBLIC_KEY`,
`DOCUSIGN_MLDSA_PRIVATE_KEY`, `DOCUSIGN_KEY_REGISTRATION_TXN_ID`.

Optional: `X402_TREASURY_ADDRESS` to enable pay-per-anchor on `/api/anchor`.

## How verification works

The verifier (`npm run verify`) exits `0` = VALID, `1` = INVALID, `2` = operational error.

| Step | Check | Offline? |
|---|---|---|
| 1 | ML-DSA-65 signature over bundle (NIST FIPS-204) | Yes |
| 2 | SHA-256(PDF) matches `bundle.documentHash` | Yes |
| 3 | Merkle proof walks from hash to root | Yes |
| 4 | Algorand txn note contains merkle root | AlgoNode (not DocuSign) |
| 5 | Falcon-512 state proof covers the anchor round | AlgoNode (not DocuSign) |

## Who uses this

- **HR platforms** — offer letters, NDAs, termination agreements with quantum-proof audit trail
- **Legal tech** — tamper-evident contract archive that survives vendor shutdown
- **Healthcare** — patient consent forms (no PII on-chain — HIPAA-compatible)
- **AI agents** — autonomous agents executing agreements need immutable, verifiable receipts
- **Anyone signing documents today** that need to be verifiable in 2040

## Proof bundle (example)

```json
{
  "protocol": "pqva/1",
  "envelopeId": "contract-2026-001",
  "documentHash": "0569e7cb...",
  "merkleRoot": "97d5d40b...",
  "merkleProof": ["9b1b4a3c...", "34b53407..."],
  "algorandTxnId": "QIS2LWKE...",
  "algorandRound": 62052659,
  "blockTimestamp": "2026-06-11T13:50:11.808Z",
  "stateProofRound": 62052864,
  "docusignSigners": [
    { "name": "Jordan Avery", "email": "jordan@acme.example", "signedAt": "2026-06-11T13:48:02Z" }
  ],
  "algorithm": "ml-dsa-65",
  "mldsaPublicKey": "...",
  "signature": "75483d62..."
}
```

Full schema: [`docs/architecture.md`](docs/architecture.md)

## Tech stack

| Component | Choice |
|---|---|
| Post-quantum signatures | `@noble/post-quantum` — ML-DSA-65 (NIST FIPS-204) |
| Blockchain | Algorand mainnet — Falcon-512 state proofs |
| AI agent interface | `@modelcontextprotocol/sdk` — MCP stdio server |
| Payments | `@x402-avm/express` — x402 on Algorand (GoPlausible) |
| Merkle trees | `merkletreejs` — SHA-256 |
| Canonical JSON | `canonicalize` — JCS, RFC 8785 |
| Runtime | TypeScript + Node.js via `tsx` |

## License

MIT — free to use, self-host, and fork.
