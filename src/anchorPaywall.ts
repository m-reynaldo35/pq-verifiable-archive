import type { Request, Response, NextFunction } from 'express';
import algosdk from 'algosdk';

const USDC_MAINNET_ASA_ID = 31566704;

function payJson(treasury: string, toll: number) {
  return {
    version: 'x402-v1',
    status: 402,
    network: { protocol: 'algorand', chain: 'mainnet' },
    payment: {
      asset: { type: 'ASA', id: USDC_MAINNET_ASA_ID, symbol: 'USDC', decimals: 6 },
      amount: toll.toString(),
      payTo: treasury,
    },
    expires: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    memo: 'pqva/anchor',
  };
}

// Verify a base64-encoded signed Algorand asset-transfer txn offline.
// Returns the sender address on success, or a rejection reason string.
function verifyPayment(header: string, treasury: string, toll: number): string | { ok: true; sender: string } {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(header, 'base64'));
  } catch {
    return 'malformed payment header (expected base64)';
  }

  let signed: ReturnType<typeof algosdk.decodeSignedTransaction>;
  try {
    signed = algosdk.decodeSignedTransaction(bytes);
  } catch {
    return 'payment header is not a valid signed Algorand transaction';
  }

  const txn = signed.txn;

  if (txn.type !== algosdk.TransactionType.axfer) {
    return `expected asset transfer (axfer), got ${txn.type}`;
  }

  const xfer = txn.assetTransfer;
  if (!xfer) return 'transaction has no asset transfer fields';

  const asaId = Number(xfer.assetIndex ?? 0);
  if (asaId !== USDC_MAINNET_ASA_ID) {
    return `wrong asset: expected USDC (${USDC_MAINNET_ASA_ID}), got ${asaId}`;
  }

  const receiver = xfer.receiver?.toString() ?? '';
  if (receiver !== treasury) {
    return `wrong receiver: expected ${treasury}, got ${receiver}`;
  }

  const amount = Number(xfer.amount ?? 0);
  if (amount < toll) {
    return `insufficient amount: expected ${toll} micro-USDC, got ${amount}`;
  }

  return { ok: true, sender: txn.sender?.toString() ?? 'unknown' };
}

// Broadcast the payment txn async — fire and forget.
// The anchor proceeds optimistically; the on-chain record is its own proof.
function broadcastAsync(header: string): void {
  const nodeUrl = process.env.ALGORAND_NODE_URL ?? 'https://mainnet-api.algonode.cloud';
  const algod = new algosdk.Algodv2('', nodeUrl, '');
  const bytes = new Uint8Array(Buffer.from(header, 'base64'));
  algod.sendRawTransaction(bytes).do().catch((err: Error) => {
    process.stderr.write(`warn: payment broadcast failed: ${err.message}\n`);
  });
}

export function requireAnchorPayment() {
  const treasury = process.env.X402_TREASURY_ADDRESS;
  if (!treasury) throw new Error('X402_TREASURY_ADDRESS not set');

  const tollUsd = parseFloat((process.env.X402_TOLL_USD ?? '$0.01').replace('$', ''));
  const toll = Math.round(tollUsd * 1_000_000); // micro-USDC

  return function x402Gate(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['payment-signature'] ?? req.headers['x-payment'];

    if (!header) {
      res.status(402).contentType('application/pay+json').json(payJson(treasury, toll));
      return;
    }

    const result = verifyPayment(header as string, treasury, toll);
    if (typeof result === 'string') {
      res.status(402).contentType('application/pay+json').json({ ...payJson(treasury, toll), error: result });
      return;
    }

    broadcastAsync(header as string);
    next();
  };
}
