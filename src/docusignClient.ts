import { createSign } from 'crypto';

export interface SignerMetadata {
  name: string;
  email: string;
  signedAt: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface RecipientsResponse {
  signers?: Array<{
    name?: string;
    email?: string;
    signedDateTime?: string;
    deliveredDateTime?: string;
  }>;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function isSandbox(): boolean {
  return process.env.DOCUSIGN_SANDBOX === 'true';
}

function authHost(): string {
  return isSandbox() ? 'account-d.docusign.com' : 'account.docusign.com';
}

function apiBaseUrl(): string {
  return isSandbox()
    ? 'https://demo.docusign.net/restapi'
    : 'https://www.docusign.net/restapi';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set in environment`);
  return value;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAssertion(): string {
  const integrationKey = requireEnv('DOCUSIGN_INTEGRATION_KEY');
  const userId = requireEnv('DOCUSIGN_USER_ID');
  const privateKeyPem = Buffer.from(requireEnv('DOCUSIGN_PRIVATE_KEY'), 'base64').toString('utf8');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: integrationKey,
    sub: userId,
    aud: authHost(),
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(privateKeyPem));

  return `${signingInput}.${signature}`;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const assertion = buildAssertion();
  const res = await fetch(`https://${authHost()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DocuSign token request failed: ${res.status} ${res.statusText} ${text}`);
  }

  const body = (await res.json()) as TokenResponse;
  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return body.access_token;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

export async function downloadEnvelopePdf(envelopeId: string): Promise<Buffer> {
  const accountId = requireEnv('DOCUSIGN_ACCOUNT_ID');
  const url = `${apiBaseUrl()}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/documents/combined`;
  const res = await fetch(url, {
    headers: { ...(await authHeaders()), Accept: 'application/pdf' },
  });

  if (!res.ok) {
    throw new Error(`Failed to download envelope ${envelopeId}: ${res.status} ${res.statusText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

export async function getSignerMetadata(envelopeId: string): Promise<SignerMetadata[]> {
  const accountId = requireEnv('DOCUSIGN_ACCOUNT_ID');
  const url = `${apiBaseUrl()}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/recipients`;
  const res = await fetch(url, {
    headers: { ...(await authHeaders()), Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch recipients for ${envelopeId}: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as RecipientsResponse;
  return (body.signers ?? []).map(signer => ({
    name: signer.name ?? '',
    email: signer.email ?? '',
    signedAt: signer.signedDateTime ?? signer.deliveredDateTime ?? '',
  }));
}
