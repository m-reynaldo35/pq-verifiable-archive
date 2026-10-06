import { createHash } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402-avm/express';
import { HTTPFacilitatorClient } from '@x402-avm/core/server';
import { ExactAvmScheme } from '@x402-avm/avm/exact/server';
import { ALGORAND_MAINNET_CAIP2 } from '@x402-avm/avm';

// Default matches the SDK's own default — only override via env for a self-hosted facilitator.
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz';

// Algorand txns are valid for at most 1000 rounds (~1 hour), so a payment
// header older than this can no longer settle and need not be remembered.
const USED_PAYMENT_TTL_MS = 2 * 60 * 60 * 1000;

// The x402 middleware verifies a payment, runs the route handler, and only then
// settles. Our handler anchors on mainnet and signs a bundle before settlement,
// so the same payment header sent N times concurrently would pass the stateless
// verify N times. This guard admits each payment header once: concurrent or
// later reuse is rejected with 409 before the paywall or handler runs.
export function paymentReplayGuard(): RequestHandler {
  const seen = new Map<string, number>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('payment-signature') ?? req.header('x-payment');
    if (!header) {
      next();
      return;
    }

    const now = Date.now();
    for (const [key, at] of seen) {
      if (now - at > USED_PAYMENT_TTL_MS) seen.delete(key);
    }

    const key = createHash('sha256').update(header).digest('hex');
    if (seen.has(key)) {
      res.status(409).json({ error: 'payment already used — sign a new payment for each anchor' });
      return;
    }
    seen.set(key, now);
    next();
  };
}

export function requireAnchorPayment() {
  const treasury = process.env.X402_TREASURY_ADDRESS;
  if (!treasury) throw new Error('X402_TREASURY_ADDRESS not set');

  const toll = process.env.X402_TOLL_USD ?? '$0.01';

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator).register(ALGORAND_MAINNET_CAIP2, new ExactAvmScheme());

  return paymentMiddleware(
    {
      'POST /api/anchor': {
        accepts: {
          scheme: 'exact',
          price: toll,
          network: ALGORAND_MAINNET_CAIP2,
          payTo: treasury,
        },
        description: 'Post-quantum document anchor to Algorand mainnet — one payment per anchor request',
      },
    },
    server,
  );
}
