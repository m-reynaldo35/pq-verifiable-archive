import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildMerkleTree } from './merkleBatcher.js';
import { anchorToAlgorand } from './algorandAnchor.js';
import { coveringRound } from './stateProofCollector.js';
import { signBundle } from './bundleSigner.js';
import { verifyBundle } from './verifyBundle.js';
import type { ProofBundle, DocuSignSigner } from './bundleSigner.js';

const server = new McpServer({
  name: 'pq-verifiable-archive',
  version: '1.0.0',
});

// anchor_document — hash a document and anchor it to Algorand
server.tool(
  'anchor_document',
  'Anchor a SHA-256 document hash to Algorand mainnet with post-quantum ML-DSA-65 attestation. Returns a self-contained proof bundle that can be verified offline decades from now without trusting any vendor.',
  {
    hash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-character lowercase hex SHA-256 hash'),
    envelope_id: z.string().optional().describe('Optional identifier for the document or envelope'),
    signers: z
      .array(
        z.object({
          name: z.string(),
          email: z.string(),
          signedAt: z.string().describe('ISO 8601 timestamp'),
        }),
      )
      .optional()
      .describe('Optional list of human signers to embed in the proof bundle'),
  },
  async ({ hash, envelope_id, signers }) => {
    const envelopeId = envelope_id ?? `doc-${Date.now()}`;
    const docusignSigners: DocuSignSigner[] = (signers ?? []).map(s => ({
      name: s.name,
      email: s.email,
      signedAt: s.signedAt,
    }));

    let anchorResult: Awaited<ReturnType<typeof anchorToAlgorand>>;
    try {
      const tree = buildMerkleTree([hash]);
      const merkleRoot = tree.getHexRoot().replace(/^0x/, '');
      anchorResult = await anchorToAlgorand(merkleRoot, [envelopeId]);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Anchor failed: ${(err as Error).message}` }],
        isError: true,
      };
    }

    const { txId, confirmedRound, blockTime } = anchorResult;
    const tree = buildMerkleTree([hash]);
    const merkleRoot = tree.getHexRoot().replace(/^0x/, '');
    const merkleProof = tree.getHexProof(Buffer.from(hash, 'hex')).map((p: string) => p.replace(/^0x/, ''));

    const unsigned: Omit<ProofBundle, 'signature'> = {
      protocol: 'pqva/1',
      envelopeId,
      documentHash: hash,
      batchId: txId,
      merkleRoot,
      merkleProof,
      algorandTxnId: txId,
      algorandRound: confirmedRound,
      ...(blockTime ? { blockTimestamp: blockTime } : {}),
      stateProofRound: coveringRound(confirmedRound),
      signingMetadata: { signers: [] },
      docusignSigners,
      docusignKeyRegistrationTxnId: process.env.DOCUSIGN_KEY_REGISTRATION_TXN_ID ?? '',
      algorithm: 'ml-dsa-65',
    };

    let bundle: ProofBundle;
    try {
      bundle = signBundle(unsigned);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Bundle signing failed: ${(err as Error).message}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              algorandTxnId: txId,
              algorandRound: confirmedRound,
              blockTimestamp: blockTime,
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

// verify_bundle — run all 5 verification checks on a proof bundle
server.tool(
  'verify_bundle',
  'Verify a PQ Verifiable Archive proof bundle. Runs 5 checks: ML-DSA-65 signature, PDF hash match (if PDF provided), Merkle inclusion, Algorand on-chain anchor, and Falcon-512 state proof coverage. Checks 1, 3, and 5 are fully offline.',
  {
    bundle: z.string().describe('Proof bundle as a JSON string'),
    pdf_base64: z
      .string()
      .optional()
      .describe('Base64-encoded PDF bytes. If provided, enables document hash verification (check 2).'),
  },
  async ({ bundle: bundleStr, pdf_base64 }) => {
    let bundle: ProofBundle;
    try {
      bundle = JSON.parse(bundleStr) as ProofBundle;
    } catch {
      return {
        content: [{ type: 'text' as const, text: 'Invalid bundle: could not parse JSON' }],
        isError: true,
      };
    }

    const pdfBuffer = pdf_base64 ? Buffer.from(pdf_base64, 'base64') : undefined;

    let result: Awaited<ReturnType<typeof verifyBundle>>;
    try {
      result = await verifyBundle(bundle, pdfBuffer);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Verification error: ${(err as Error).message}` }],
        isError: true,
      };
    }

    const stepSummary = result.steps
      .map(s => {
        const icon = s.skipped ? '⊘' : s.informational ? 'ℹ' : s.passed ? '✓' : '✗';
        return `${icon} ${s.name}: ${s.detail}`;
      })
      .join('\n');

    const verdict = result.valid ? 'VALID' : 'INVALID';
    const signerList =
      result.signers.length > 0
        ? result.signers.map(s => `  • ${s.name} <${s.email}> at ${s.signedAt}`).join('\n')
        : '  (none recorded)';

    const output = `${verdict}\n\nSteps:\n${stepSummary}\n\nSigners:\n${signerList}`;

    return {
      content: [{ type: 'text' as const, text: output }],
    };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  process.stderr.write(`MCP server error: ${(err as Error).message}\n`);
  process.exit(1);
});
