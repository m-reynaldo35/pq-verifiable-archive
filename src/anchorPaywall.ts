import { paymentMiddleware, x402ResourceServer } from '@x402-avm/express';
import { HTTPFacilitatorClient } from '@x402-avm/core/server';
import { ExactAvmScheme } from '@x402-avm/avm/exact/server';
import { ALGORAND_MAINNET_CAIP2 } from '@x402-avm/avm';

// Default matches the SDK's own default — only override via env for self-hosted facilitator.
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz';

export function requireAnchorPayment() {
  const treasury = process.env.X402_TREASURY_ADDRESS;
  if (!treasury) throw new Error('X402_TREASURY_ADDRESS not set');

  const toll = process.env.X402_TOLL_USD ?? '$0.01';

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator).register(
    ALGORAND_MAINNET_CAIP2,
    new ExactAvmScheme(),
  );

  return paymentMiddleware(
    {
      'POST /api/anchor': {
        accepts: {
          scheme: 'exact',
          price: toll,
          network: ALGORAND_MAINNET_CAIP2,
          payTo: treasury,
        },
        description: 'Post-quantum document anchor to Algorand mainnet — pay once per hash',
      },
    },
    server,
  );
}
