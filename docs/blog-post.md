# Post-quantum document anchoring for AI agents on Algorand

There's a quiet assumption baked into every e-signature platform: that RSA and ECDSA will still be hard to break when someone needs to prove the document is authentic. For a contract signed today and enforced in 2040, that assumption is worth examining.

NIST finalised ML-DSA (FIPS-204) in August 2024 — the first post-quantum signature standard ready for production use. Algorand has been producing Falcon-512 state proofs over every block since 2022. The standards exist. The chain infrastructure exists. What was missing was a simple, open tool that wires them together and exposes them to the AI agents now autonomously executing agreements.

That's what PQ Verifiable Archive is. It's open source, it runs on Algorand mainnet, and you can call it today.

---

## The problem with documents signed today

A signed PDF sitting in a DocuSign vault has an integrity guarantee based on an RSA or ECDSA certificate chain. A large enough quantum computer breaks both. CNSA 2.0 mandates post-quantum cryptography for national-security systems by roughly 2030–2035, and regulated industries will be close behind. "Harvest now, decrypt later" is already happening — adversaries are archiving signed artifacts to attack once the hardware lands.

The document you sign today may need to be verified in 2040. The signature on it will not survive.

---

## What PQ Verifiable Archive does

It adds a quantum-resistant notarisation layer to any signed document, without requiring you to change your signing tool.

The flow is straightforward:

1. Take a SHA-256 hash of your signed PDF
2. Anchor that hash to Algorand mainnet in a transaction note
3. Sign a self-contained **proof bundle** with ML-DSA-65 (NIST FIPS-204)
4. Hand anyone the bundle — they can verify it offline, decades from now, without trusting any vendor

The bundle looks like this:

```json
{
  "protocol": "pqva/1",
  "envelopeId": "contract-2026-001",
  "documentHash": "d88c1a367ad6e6bc...",
  "merkleRoot": "d88c1a367ad6e6bc...",
  "algorandTxnId": "QZDHEO4JKMRUXHNABS5AVRM53PYKBPKUUFULDBV2LANN3Z37PWAA",
  "algorandRound": 62158259,
  "blockTimestamp": "2026-06-14T22:18:41.000Z",
  "stateProofRound": 62158464,
  "algorithm": "ml-dsa-65",
  "mldsaPublicKey": "b1509e56...",
  "signature": "75483d62..."
}
```

Nothing in the bundle reveals document contents. Only irreversible hashes touch the chain.

---

## Five checks, three offline

The verifier runs five checks. Three of them need no network connection at all — they work from the bundle alone:

| Check | What it proves | Network? |
|-------|---------------|----------|
| ML-DSA-65 signature | Bundle hasn't been tampered with since signing | No |
| SHA-256(PDF) match | Correct document was anchored | No (needs PDF) |
| Merkle inclusion | This hash is under the claimed root | No |
| Algorand anchor | Root appears in on-chain transaction note | AlgoNode only |
| Falcon-512 state proof | Block is covered by Algorand's native PQC proof | AlgoNode only |

Steps 4 and 5 query AlgoNode — a public indexer — not a private vendor API. Anyone can run a verification against the public Algorand ledger forever.

---

## An MCP tool for AI agents

AI agents are already signing NDA terms, executing purchase orders, and creating binding agreements autonomously. When an agent acts on your behalf, you need a machine-readable, tamper-evident receipt — not a PDF in a folder that disappears when a vendor shuts down.

PQ Verifiable Archive ships as a Model Context Protocol server. Add it to Claude's settings:

```json
{
  "mcpServers": {
    "pq-verifiable-archive": {
      "command": "npx",
      "args": ["tsx", "/path/to/pq-verifiable-archive/src/mcp-server.ts"],
      "env": {
        "ALGORAND_MNEMONIC": "your 25-word mnemonic",
        "DOCUSIGN_MLDSA_PUBLIC_KEY": "...",
        "DOCUSIGN_MLDSA_PRIVATE_KEY": "...",
        "DOCUSIGN_KEY_REGISTRATION_TXN_ID": "..."
      }
    }
  }
}
```

Claude can then call two tools directly:

- `anchor_document(hash, envelope_id?, signers?)` — anchors to Algorand mainnet, returns a proof bundle
- `verify_bundle(bundle, pdf_base64?)` — runs all five checks, returns structured pass/fail

An agent executing a contract can anchor the signed hash immediately after execution, attach the bundle to its audit log, and any party can verify the record independently years later. No trust in the agent's vendor required.

---

## Pay per anchor via x402 on the hosted API

If you don't want to run your own node, the hosted API at `pq-verifiable-archive-production.up.railway.app` charges **$0.01 USDC per anchor** using the x402 micropayment protocol on Algorand.

The flow is entirely automated:

```
POST /api/anchor  →  402 (payment required)
                 →  build USDC payment transaction
                 →  POST /api/anchor with payment-signature header
                 →  anchor confirmed + proof bundle returned
```

The GoPlausible facilitator handles gas fees — the payer only transfers USDC. There's no API key, no account, no billing dashboard. An AI agent with a funded Algorand wallet can anchor documents with no human in the loop.

Self-hosted use is completely free. You pay only Algorand's ~$0.0002 network fee per anchor.

---

## What we tested

Six consecutive E2E test runs, each one a unique document hash anchored to Algorand mainnet with a real USDC payment:

| Run | Algorand Txn | Round |
|-----|-------------|-------|
| 1 | `QZDHEO4J...` | 62158259 |
| 2 | `IIQC4D75...` | 62158297 |
| 3 | `DTSKHBWO...` | 62158363 |
| 4 | `KP226VBK...` | 62158366 |
| 5 | `HYFTNAIE...` | 62158369 |
| 6 | `SY7JCOZV...` | 62158372 |

Each run: payment verified by GoPlausible facilitator → atomic group submitted → anchor confirmed in ~9 seconds → ML-DSA-65 bundle signed and returned → all five verification checks pass.

---

## Why Algorand

Two reasons that matter for long-lived documents.

**Native post-quantum state proofs.** Algorand produces Falcon-512 proofs over every ~256-round interval automatically. The anchor doesn't just sit in a transaction note — it sits in a block that is itself covered by a post-quantum attestation. You get two layers of quantum resistance: ML-DSA-65 on the bundle, Falcon-512 on the ledger.

**Permissionless verification.** Any party can query the Algorand public indexer forever. The integrity of a document from 2026 doesn't depend on this project's servers being up in 2040. It depends on the public Algorand ledger — which anyone can run a node for.

---

## Who this is for

**Legal tech and HR platforms.** Offer letters, NDAs, termination agreements, patient consents. Anything signed today that a regulator might scrutinise in ten years.

**AI agents executing agreements.** Autonomous agents need receipts that outlive the session and the vendor. An immutable on-chain anchor with a verifiable ML-DSA signature is the right format.

**Anyone building on Algorand.** The MCP server, the proof bundle format, and the verification library are all open. Fork it, integrate it, build on it.

---

## Get started

```bash
# Self-hosted (free)
git clone https://github.com/m-reynaldo35/pq-verifiable-archive.git
cd pq-verifiable-archive
npm install
cp .env.example .env   # fill in ALGORAND_MNEMONIC and ML-DSA keys
npm run register-key   # registers your ML-DSA-65 public key on-chain
npm start              # REST API on :3000
npm run mcp            # MCP stdio server for AI agents
```

```bash
# Hosted API — no setup, $0.01/anchor
# (use any x402-compatible client or the test script in scripts/)
```

The repository is at [github.com/m-reynaldo35/pq-verifiable-archive](https://github.com/m-reynaldo35/pq-verifiable-archive). Issues, PRs, and forks welcome.

The window between "NIST finalised the standard" and "everyone has implemented it" is where this matters most. Documents being signed right now are the ones that need protecting.
