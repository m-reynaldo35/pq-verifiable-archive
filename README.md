# PQ Verifiable Archive

A post-quantum, vendor-independent tamper-evidence layer for DocuSign envelopes.
On envelope completion, the completed PDF is SHA-256 hashed (never stored),
Merkle-batched, and the batch root is anchored in an Algorand mainnet transaction —
where the network's native Falcon-512 state proofs quantum-resistantly cover the
record. Each envelope receives a self-contained JSON proof bundle, signed with an
institutional ML-DSA-65 (FIPS-204) key, that an offline verifier can validate decades
later without trusting — or even reaching — DocuSign's servers.

Live on Algorand mainnet: real transactions, real ML-DSA-65 signatures, a working
offline verifier.

## DocuSign today vs. PQ Verifiable Archive

| Property | DocuSign today | PQ Verifiable Archive |
|---|---|---|
| Quantum-resistant | No (RSA / ECDSA signature chain) | Yes (ML-DSA-65 + Algorand Falcon-512 state proofs) |
| Offline-verifiable | No (requires DocuSign servers) | Yes (bundle + public ledger; 3 of 5 checks fully offline) |
| Vendor-independent | No (trust DocuSign) | Yes (verify against a public, permissionless chain) |
| PII on-chain | n/a | None — only irreversible SHA-256 hashes are anchored |
| Standards | RSA / ECDSA | NIST FIPS-204 (ML-DSA), SHA-256, JCS (RFC 8785) |

## Quick start

```bash
git clone https://github.com/m-reynaldo35/docutestproject.git
cd docutestproject
npm install
cp .env.example .env        # then fill in keys (see .env.example)
npm start                   # starts the webhook server (src/server.ts)
```

Generate the demo contract and verify a bundle:

```bash
npx tsx scripts/generate-sample-pdf.ts        # writes assets/sample-contract.pdf
npm run verify -- --bundle bundles/sample-contract-bundle.json --pdf assets/sample-contract.pdf
```

Required environment variables (see `.env.example`): `ALGORAND_NODE_URL`,
`ALGORAND_INDEXER_URL`, `ALGORAND_MNEMONIC`, `DOCUSIGN_MLDSA_PUBLIC_KEY`,
`DOCUSIGN_MLDSA_PRIVATE_KEY`, `DOCUSIGN_KEY_REGISTRATION_TXN_ID`, and the DocuSign
sandbox credentials for the Connect bridge.

## How verification works

The offline verifier (`verifier/verify.ts`) exits `0` on VALID, `1` on INVALID,
`2` on operational error. It runs five checks:

1. **ML-DSA-65 attestation** — verify the bundle signature against DocuSign's
   registered public key (offline).
2. **PDF hash match** — `SHA-256(pdf) === bundle.documentHash`, when `--pdf` is
   supplied (offline).
3. **Merkle inclusion** — walk `bundle.merkleProof` from `documentHash` to
   `bundle.merkleRoot` (offline).
4. **On-chain anchor** — confirm via AlgoNode that the anchor transaction's note
   contains `merkleRoot` (public ledger, not DocuSign).
5. **State proof coverage** — resolve the Falcon-512 state proof round covering the
   anchor (public ledger, not DocuSign).

## Proof bundle example (abbreviated)

```json
{
  "protocol": "pqva/1",
  "envelopeId": "env-001",
  "documentHash": "0569e7cb12153b008a797306a898bd2755aac36c89ac1f192343eb2143e22e87",
  "merkleRoot": "97d5d40bb8c9a7498f641a0e30f61111f152e4ddb6e887cf8835928438025bb7",
  "merkleProof": ["9b1b4a3c...", "34b53407..."],
  "algorandTxnId": "QIS2LWKECOFIFQ4M3GWFG5CK35Z74AVYSUTFH7EUSZPVLZ27KFEA",
  "algorandRound": 62052659,
  "blockTimestamp": "2026-06-11T13:50:11.808Z",
  "stateProofRound": 62052864,
  "docusignSigners": [
    { "name": "Jordan Avery", "email": "jordan@acme.example", "signedAt": "2026-06-11T13:48:02Z" }
  ],
  "docusignKeyRegistrationTxnId": "BUVBKZAYLHFLAX4WLD7KA7OQZAE4QYHGY3SHY3TVKVJFGQXP3IJA",
  "algorithm": "ml-dsa-65",
  "signature": "75483d62...<ML-DSA-65 signature, hex>"
}
```

The full schema and field descriptions are in [`docs/architecture.md`](docs/architecture.md).

## Tech stack

| Component | Choice |
|---|---|
| Language / runtime | TypeScript, Node.js (run via `tsx`) |
| Post-quantum signatures | `@noble/post-quantum` (ML-DSA-65, FIPS-204) |
| Blockchain | Algorand mainnet via `algosdk` (Falcon-512 state proofs) |
| Merkle trees | `merkletreejs` (SHA-256) |
| Canonical JSON | `canonicalize` (JCS, RFC 8785) |
| Webhook server | `express` |
| CLI | `commander` |
| Demo PDF | `pdfkit` |

## Documentation

- [`docs/pitch.md`](docs/pitch.md) — executive 1-pager
- [`docs/architecture.md`](docs/architecture.md) — data flow, bundle schema, verification
- [`docs/compliance-faq.md`](docs/compliance-faq.md) — legal / GRC Q&A
- [`ROADMAP.md`](ROADMAP.md) — phased build plan (Phases 0–5 complete)
