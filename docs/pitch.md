# PQ Verifiable Archive

### A post-quantum tamper-evidence layer for DocuSign envelopes

---

## Problem

A mortgage signed today is enforceable in 2050. So are IP assignments, M&A
agreements, and clinical-trial consents. Their signatures rest on RSA and ECDSA —
algorithms a cryptographically relevant quantum computer breaks. "Harvest now,
decrypt later" is not hypothetical: adversaries are already archiving signed
artifacts to forge or repudiate them once the hardware lands. DocuSign's signature
chain has no post-quantum layer. The integrity guarantee on every long-lived
contract DocuSign processes has a known expiry date.

## Solution

A single Connect webhook integration. On envelope completion we SHA-256 the
completed PDF and anchor a Merkle root over that hash in an Algorand mainnet
transaction (one transaction per envelope today; batching is a planned cost
optimisation). Each envelope gets a self-contained JSON **proof bundle** signed with
an ML-DSA-65 (FIPS-204) issuer key. In the proposed product DocuSign would hold that
key; in this proof-of-concept the operator of the service holds it. An open-source
verifier proves any envelope's integrity decades later without DocuSign's servers:
the signature, document hash and Merkle proof check offline against a pinned issuer
key, and the anchor is confirmed against any archival Algorand indexer. **No names,
emails or document content touch the chain** — only hashes, which are pseudonymous
(anyone holding the document can confirm it was anchored).

This runs today on Algorand mainnet: real transactions, real ML-DSA-65 signatures, a
working verifier.

## Why Now

NIST finalised ML-DSA as FIPS-204 in August 2024 — it is now a citable standard, not
a research candidate. CNSA 2.0 mandates PQC across national-security and regulated
federal procurement by ~2030–2035, with adoption beginning well before. Finance,
healthcare, and defence customers will ask DocuSign for a post-quantum integrity
story before DocuSign has one to give. The window to lead rather than react is open
now and closes as competitors and standards bodies move.

## Why Algorand

Algorand already produces **native Falcon-512 state proofs** — post-quantum
attestations over ledger history, in production today. That gives a path to
verifying anchors without trusting an indexer; the current verifier only reports
whether a covering state proof exists and does not yet check it cryptographically.
The chain is public and free to query, so verification depends on no single vendor. It is permissionless, so there is no lock-in: any
party can confirm a record against the public ledger forever.

## Why ML-DSA

FIPS-204 is fully standardised and CNSA 2.0-approved — a defensible compliance claim
to a regulator or auditor. Alternatives are weaker: Falcon (FN-DSA) is not yet
finalised, and PKCS#7 PQC extensions are years out. ML-DSA-65 is the conservative,
auditable choice for an institutional key meant to outlive the document.

## Build vs. Borrow

This is a roughly four-week engineering effort that DocuSign can absorb as a product
feature — the proof-of-concept is already built. The alternatives are worse: wait on
PKCS#7 PQC extensions (multi-year, outside DocuSign's control) or stand up a custom
trusted timestamping authority (expensive, centralised, and exactly the
single-point-of-trust customers are trying to escape). Anchoring to a public PQC
chain is cheaper, faster, and more credible than building trust infrastructure
from scratch.

## The Ask

A 30-minute technical deep-dive with product and security, plus access to a DocuSign
developer sandbox so we can run the full live demo end-to-end: sign an envelope,
watch the bundle generate, and verify it offline in front of you.
