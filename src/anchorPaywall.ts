import type { Request, Response, NextFunction, RequestHandler } from 'express';
import algosdk from 'algosdk';
import { x402ResourceServer, x402HTTPResourceServer, ExpressAdapter } from '@x402-avm/express';
import type { PaymentPayload } from '@x402-avm/express';
import { HTTPFacilitatorClient } from '@x402-avm/core/server';
import { decodePaymentSignatureHeader } from '@x402-avm/core/http';
import { ExactAvmScheme } from '@x402-avm/avm/exact/server';
import { ALGORAND_MAINNET_CAIP2 } from '@x402-avm/avm';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402-avm/extensions/bazaar';
import { tryClaim, readClaim, setClaim, releaseClaim } from './claims.js';

// Default matches the SDK's own default — only override via env for a self-hosted facilitator.
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz';
const PUBLIC_URL = process.env.PQVA_PUBLIC_URL ?? 'https://pq-verifiable-archive.vercel.app';

// A paid-but-unfulfilled payment (anchoring failed after settlement) can be
// redeemed by resending the same payment header, after this grace period so an
// in-flight request is not duplicated.
const RETRY_AFTER_MS = 30_000;

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

// Canonical identity of a payment: the txn id of the payer-signed payment txn.
// Unlike the raw header, it cannot be changed by re-encoding the base64 or
// re-serialising the JSON, so one payment can be used for one anchor only.
export function canonicalPaymentId(payload: Pick<PaymentPayload, 'payload'>): string | null {
  const p = (payload.payload ?? {}) as { paymentGroup?: unknown; paymentIndex?: unknown };
  if (!Array.isArray(p.paymentGroup) || typeof p.paymentIndex !== 'number') return null;
  const encoded = p.paymentGroup[p.paymentIndex];
  if (typeof encoded !== 'string') return null;
  try {
    return algosdk.decodeSignedTransaction(Buffer.from(encoded, 'base64')).txn.txID();
  } catch {
    return null;
  }
}

function paymentIdFromHeader(header: string): string | null {
  try {
    return canonicalPaymentId(decodePaymentSignatureHeader(header));
  } catch {
    return null;
  }
}

function buildHttpServer(treasury: string, toll: string): x402HTTPResourceServer {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator)
    .register(ALGORAND_MAINNET_CAIP2, new ExactAvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  return new x402HTTPResourceServer(server, {
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
  });
}

function sendInstructions(res: Response, r: { status: number; headers: Record<string, string>; body?: unknown }): void {
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  res.status(r.status).json(r.body ?? {});
}

// x402 gate for POST /api/anchor that SETTLES BEFORE the handler runs:
//   verify -> claim payment txn id -> settle -> anchor (handler) -> mark fulfilled.
// Nothing is written to storage until the facilitator has verified the
// payment, so junk headers cost nothing. Facilitator sync is lazy and retried,
// so an outage never leaves an unhandled rejection or a poisoned instance.
export function requireAnchorPayment(): RequestHandler {
  const treasury = process.env.X402_TREASURY_ADDRESS;
  if (!treasury) throw new Error('X402_TREASURY_ADDRESS not set');
  const toll = process.env.X402_TOLL_USD ?? '$0.01';

  let httpServer: x402HTTPResourceServer | undefined;
  let ready: Promise<void> | undefined;
  async function getServer(): Promise<x402HTTPResourceServer> {
    httpServer ??= buildHttpServer(treasury as string, toll);
    ready ??= httpServer.initialize().catch(e => {
      ready = undefined;
      throw e;
    });
    await ready;
    return httpServer;
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let server: x402HTTPResourceServer;
    try {
      server = await getServer();
    } catch (e) {
      console.error(`x402 facilitator sync failed: ${(e as Error).message}`);
      res.status(503).json({ error: 'payment service temporarily unavailable — retry shortly' });
      return;
    }

    const header = req.header('payment-signature');

    // A payment already seen: either redeem it (settled earlier, anchor failed)
    // or refuse it. Read-only, so junk headers still cost no writes.
    if (header) {
      const id = paymentIdFromHeader(header);
      if (id) {
        const prior = await readClaim(`payments/${id}`).catch(() => null);
        if (prior?.state === 'settled' && Date.now() - prior.at > RETRY_AFTER_MS) {
          res.locals.paymentKey = `payments/${id}`;
          next();
          return;
        }
        if (prior) {
          res.status(409).json({ error: 'payment already used — sign a new payment for each anchor' });
          return;
        }
      }
    }

    const adapter = new ExpressAdapter(req);
    const context = { adapter, path: req.path, method: req.method, paymentHeader: header };
    let result: Awaited<ReturnType<x402HTTPResourceServer['processHTTPRequest']>>;
    try {
      result = await server.processHTTPRequest(context);
    } catch (e) {
      console.error(`x402 verify failed: ${(e as Error).message}`);
      res.status(503).json({ error: 'payment service temporarily unavailable — retry shortly' });
      return;
    }
    if (result.type === 'no-payment-required') {
      next();
      return;
    }
    if (result.type === 'payment-error') {
      sendInstructions(res, result.response);
      return;
    }

    // Verified. Claim the payment's canonical id before settling, so the same
    // payment (in any encoding) can only ever settle into one anchor.
    const id = canonicalPaymentId(result.paymentPayload);
    if (!id) {
      res.status(402).json({ error: 'unrecognised payment payload' });
      return;
    }
    const key = `payments/${id}`;
    let claim: Awaited<ReturnType<typeof tryClaim>>;
    try {
      claim = await tryClaim(key, 'settling');
    } catch (e) {
      console.error(`payment claim failed: ${(e as Error).message}`);
      res.status(503).json({ error: 'payment processing temporarily unavailable' });
      return;
    }
    if (!claim.fresh) {
      res.status(409).json({ error: 'payment already used — sign a new payment for each anchor' });
      return;
    }

    let settle: Awaited<ReturnType<x402HTTPResourceServer['processSettlement']>>;
    try {
      settle = await server.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, {
        request: context,
      });
    } catch (e) {
      console.error(`x402 settlement error: ${(e as Error).message}`);
      await releaseClaim(key).catch(() => undefined);
      res.status(402).json({ error: 'payment settlement failed' });
      return;
    }
    if (!settle.success) {
      await releaseClaim(key).catch(() => undefined);
      sendInstructions(res, settle.response);
      return;
    }

    await setClaim(key, 'settled').catch(e => console.error(`could not record settlement: ${(e as Error).message}`));
    for (const [k, v] of Object.entries(settle.headers)) res.setHeader(k, v);
    res.locals.paymentKey = key;
    next();
  };
}

// Called by the anchor handler once the bundle has been produced.
export async function markPaymentFulfilled(res: Response): Promise<void> {
  const key = res.locals.paymentKey as string | undefined;
  if (key) await setClaim(key, 'fulfilled').catch(e => console.error(`could not record fulfilment: ${(e as Error).message}`));
}
