import { createHash } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402-avm/express';
import { HTTPFacilitatorClient } from '@x402-avm/core/server';
import { ExactAvmScheme } from '@x402-avm/avm/exact/server';
import { ALGORAND_MAINNET_CAIP2 } from '@x402-avm/avm';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402-avm/extensions/bazaar';
import { getStorage } from './storage.js';

// Default matches the SDK's own default — only override via env for a self-hosted facilitator.
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz';

// The x402 middleware verifies a payment, runs the route handler, and only then
// settles. Our handler anchors on mainnet and signs a bundle before settlement,
// so the same payment header sent N times concurrently would pass the stateless
// verify N times. This guard admits each payment header once, across all
// instances (the claim is stored durably — Vercel Blob in production). Reuse is
// rejected with 409 before the paywall or handler runs; if the claim store is
// unavailable the request is refused (fail closed).
export function paymentReplayGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('payment-signature') ?? req.header('x-payment');
    if (!header) {
      next();
      return;
    }
    const key = `payments/${createHash('sha256').update(header).digest('hex')}`;
    getStorage()
      .claim(key)
      .then(fresh => {
        if (fresh) next();
        else res.status(409).json({ error: 'payment already used — sign a new payment for each anchor' });
      })
      .catch(e => {
        console.error(`payment replay guard unavailable: ${(e as Error).message}`);
        res.status(503).json({ error: 'payment processing temporarily unavailable' });
      });
  };
}

const PUBLIC_URL = process.env.PQVA_PUBLIC_URL ?? 'https://pq-verifiable-archive.vercel.app';

// x402 Bazaar discovery: with the bazaar extension registered, every 402
// response carries this metadata, and the facilitator catalogs the route in
// its public discovery list (facilitator.goplausible.xyz/discovery/resources)
// after the next settled payment. The examples are real shapes from a live
// paid anchor on 2026-10-06.
const anchorDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: {
    hash: '7ad4c3341e5c37b4bdc1001abbb3b99ecbb3ea42deca98ea7e6b7366805be991',
    envelope_id: 'contract-001',
  },
  inputSchema: {
    type: 'object',
    required: ['hash'],
    properties: {
      hash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'SHA-256 of the document, lowercase hex' },
      envelope_id: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$', description: 'Optional document identifier' },
      signers: {
        type: 'array',
        maxItems: 50,
        description: 'Optional; recorded as requester-asserted (unverified)',
        items: {
          type: 'object',
          required: ['name', 'email', 'signedAt'],
          properties: { name: { type: 'string' }, email: { type: 'string' }, signedAt: { type: 'string' } },
        },
      },
    },
  },
  output: {
    example: {
      success: true,
      algorandTxnId: '5V47FZ65L4AO2UWOSEP73GGKGFYOQ672URVRE5F6GPGL3M7G6EHA',
      algorandRound: 65727529,
      bundle: {
        protocol: 'pqva/2',
        documentHash: '7ad4c3341e5c37b4bdc1001abbb3b99ecbb3ea42deca98ea7e6b7366805be991',
        merkleRoot: '170c1f67b7709e58…',
        issuerAddress: 'XCJOXAMHVPXGFJHHKF3CUSVD7CD44Z4FB3BFXZYH46HYX6NUQ7TANSWAMM',
        algorithm: 'ml-dsa-65',
        signature: '… (3309-byte ML-DSA-65 signature, hex)',
      },
    },
  },
});

// x402-merchant extension: gives the facilitator's merchant page a real name
// instead of a hash (same wire format as the reference eth-avm-light-client).
const merchantExtension = {
  'x402-merchant': {
    info: {
      name: 'PQ Verifiable Archive',
      website: 'https://github.com/m-reynaldo35/pq-verifiable-archive',
      categories: ['api', 'algorand', 'post-quantum', 'verification', 'documents', 'x402'],
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        website: { type: 'string' },
        logo: { type: 'string' },
        categories: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

function buildPaymentMiddleware(treasury: string, toll: string) {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator)
    .register(ALGORAND_MAINNET_CAIP2, new ExactAvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  return paymentMiddleware(
    {
      'POST /api/anchor': {
        accepts: {
          scheme: 'exact',
          price: toll,
          network: ALGORAND_MAINNET_CAIP2,
          payTo: treasury,
          // Attribution key for the x402 Global Challenge leaderboard: without
          // it, payments settle but are not counted.
          extra: { tag: 'x402-global-challenge' },
        },
        resource: `${PUBLIC_URL}/api/anchor`,
        mimeType: 'application/json',
        description:
          'Anchor a document SHA-256 hash to Algorand mainnet and receive a proof bundle signed with ML-DSA-65 ' +
          '(NIST FIPS-204, post-quantum). Verify free at POST /api/verify or offline with the open-source CLI.',
        extensions: { ...anchorDiscovery, ...merchantExtension },
      },
    },
    server,
  );
}

export function requireAnchorPayment(): RequestHandler {
  const treasury = process.env.X402_TREASURY_ADDRESS;
  if (!treasury) throw new Error('X402_TREASURY_ADDRESS not set');
  const toll = process.env.X402_TOLL_USD ?? '$0.01';

  // The x402 middleware syncs with the facilitator once, on first use, and
  // keeps the resulting promise. If that sync fails (e.g. a network blip on a
  // serverless cold start) every later request on the instance re-throws it.
  // Rebuild the middleware after a failure so the next request retries.
  let middleware = buildPaymentMiddleware(treasury, toll);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await middleware(req, res, next);
    } catch (e) {
      console.error(`payment middleware failed, rebuilding: ${(e as Error).message}`);
      middleware = buildPaymentMiddleware(treasury, toll);
      if (!res.headersSent) {
        res.status(503).json({ error: 'payment service temporarily unavailable — retry shortly' });
      }
    }
  };
}
