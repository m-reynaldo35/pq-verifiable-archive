import dotenv from 'dotenv';

// Load signing config from .env for convenience, but never let a .env file in
// the working directory decide which issuers verify_bundle trusts: keep only
// PQVA_TRUSTED_* values that were set explicitly in the process environment.
const explicitTrust = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('PQVA_TRUSTED_')));
dotenv.config({ quiet: true });
for (const k of Object.keys(process.env)) {
  if (k.startsWith('PQVA_TRUSTED_') && !(k in explicitTrust)) delete process.env[k];
}
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createProofBundle } from './proofBundleAssembler.js';
import { assertSigningKeysConsistent } from './bundleSigner.js';
import { verifyBundle } from './verifyBundle.js';
import { validateSigners, validateEnvelopeId, MAX_SIGNERS } from './signers.js';
import { trustAnchorFromEnv } from './config.js';

// Every anchor_document call spends a mainnet fee and creates a signed
// attestation. Cap calls per UTC day so a looping or prompt-injected agent
// cannot run up cost or mint unlimited bundles.
const MAX_ANCHORS_PER_DAY = Number(process.env.MCP_MAX_ANCHORS_PER_DAY ?? 25);
let budgetDay = '';
let anchorsToday = 0;

function takeAnchorBudget(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    anchorsToday = 0;
  }
  if (anchorsToday >= MAX_ANCHORS_PER_DAY) return false;
  anchorsToday++;
  return true;
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

const server = new McpServer({
  name: 'pq-verifiable-archive',
  version: '2.0.0',
});

server.tool(
  'anchor_document',
  'Anchor a SHA-256 document hash to Algorand mainnet and return a proof bundle signed with ML-DSA-65 (NIST FIPS-204). ' +
    'Costs an Algorand network fee per call and is limited per day. Any signers you pass are recorded as ' +
    '"requester-asserted": the bundle proves you claimed them, not that they signed.',
  {
    hash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-character lowercase hex SHA-256 hash'),
    envelope_id: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional()
      .describe('Optional identifier for the document (1-128 chars of A-Za-z0-9._:-)'),
    signers: z
      .array(z.object({ name: z.string(), email: z.string(), signedAt: z.string().describe('ISO 8601 timestamp') }))
      .max(MAX_SIGNERS)
      .optional()
      .describe('Optional signer records. Stored as requester-asserted (unverified).'),
  },
  async ({ hash, envelope_id, signers }) => {
    const envelopeId = envelope_id === undefined ? `doc-${Date.now()}` : validateEnvelopeId(envelope_id);
    if (!envelopeId) return errorResult('Invalid envelope_id');

    const checked = validateSigners(signers ?? []);
    if ('error' in checked) return errorResult(`Invalid signers: ${checked.error}`);

    if (!takeAnchorBudget()) {
      return errorResult(`Daily anchor limit reached (${MAX_ANCHORS_PER_DAY}). Raise MCP_MAX_ANCHORS_PER_DAY to allow more.`);
    }

    let bundle: Awaited<ReturnType<typeof createProofBundle>>;
    try {
      bundle = await createProofBundle({
        documentHash: hash,
        envelopeId,
        signers: checked.signers,
        signerSource: 'requester-asserted',
      });
    } catch (err) {
      return errorResult(`Anchor failed: ${(err as Error).message}`);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              algorandTxnId: bundle.algorandTxnId,
              algorandRound: bundle.algorandRound,
              blockTimestamp: bundle.blockTimestamp,
              stateProofRound: bundle.stateProofRound,
              bundle,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'verify_bundle',
  'Verify a PQ Verifiable Archive proof bundle against the configured trusted issuer. Checks: ML-DSA-65 signature and issuer key, ' +
    'document hash (if a PDF is provided), Merkle inclusion, and the Algorand anchor txn (sender, round, note). ' +
    'Also reports, informationally, whether an indexer lists a state-proof txn covering the anchor round. ' +
    'Steps 2-3 are offline; Step 1 is offline when the issuer key fingerprint is pinned; Steps 4-5 query an Algorand indexer.',
  {
    bundle: z.string().describe('Proof bundle as a JSON string'),
    pdf_base64: z
      .string()
      .optional()
      .describe('Base64-encoded document bytes. Without it only the bundle is verified, not the document.'),
  },
  async ({ bundle: bundleStr, pdf_base64 }) => {
    let bundle: unknown;
    try {
      bundle = JSON.parse(bundleStr);
    } catch {
      return errorResult('Invalid bundle: could not parse JSON');
    }

    const pdfBuffer = pdf_base64 ? Buffer.from(pdf_base64, 'base64') : undefined;

    let result: Awaited<ReturnType<typeof verifyBundle>>;
    try {
      result = await verifyBundle(bundle, pdfBuffer, {
        trust: trustAnchorFromEnv(),
        indexerUrl: process.env.ALGORAND_INDEXER_URL || undefined,
      });
    } catch (err) {
      return errorResult(`Verification error: ${(err as Error).message}`);
    }

    const stepSummary = result.steps
      .map(s => {
        const icon = s.skipped ? '⊘' : s.informational ? 'ℹ' : s.error ? '!' : s.passed ? '✓' : '✗';
        return `${icon} ${s.name}: ${s.detail}`;
      })
      .join('\n');

    const verdict = !result.valid
      ? result.operationalError
        ? 'COULD NOT VERIFY'
        : 'INVALID'
      : result.documentChecked
        ? 'VALID'
        : 'BUNDLE VALID — document not checked';
    const signerHeading =
      result.signerSource === 'docusign-connect'
        ? 'Signers (reported by DocuSign to the issuer):'
        : 'Signers (asserted by the requester, NOT verified):';
    const signerList =
      result.signers.length > 0
        ? result.signers.map(s => `  • ${s.name} <${s.email}> at ${s.signedAt}`).join('\n')
        : '  (none recorded)';

    const anchored = result.anchoredAt ? `\nAnchored at (ledger time): ${result.anchoredAt}` : '';
    return {
      content: [{ type: 'text' as const, text: `${verdict}${anchored}\n\nSteps:\n${stepSummary}\n\n${signerHeading}\n${signerList}` }],
    };
  },
);

try {
  assertSigningKeysConsistent();
} catch (e) {
  process.stderr.write(`warn: anchor_document unavailable — ${(e as Error).message}\n`);
}

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  process.stderr.write(`MCP server error: ${(err as Error).message}\n`);
  process.exit(1);
});
