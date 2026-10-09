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

interface UserInfoResponse {
  accounts?: Array<{ account_id?: string; base_uri?: string }>;
}

// Production accounts live on regional hosts (na2, na3, eu, au, …), so the
// REST base must come from the account's base_uri, never a fixed host.
export function apiBaseFromUserInfo(info: UserInfoResponse, accountId: string): string {
  const account = (info.accounts ?? []).find(a => a.account_id === accountId);
  if (!account?.base_uri) throw new Error(`DocuSign account ${accountId} not found for this user`);
  const base = new URL(account.base_uri);
  if (base.protocol !== 'https:' || !/(^|\.)docusign\.net$/.test(base.hostname)) {
    throw new Error(`unexpected DocuSign base_uri: ${account.base_uri}`);
  }
  return `${base.origin}/restapi`;
}

let cachedApiBase: string | null = null;

async function apiBaseUrl(): Promise<string> {
  if (cachedApiBase) return cachedApiBase;
  const override = process.env.DOCUSIGN_BASE_URI;
  if (override) {
    cachedApiBase = `${override.replace(/\/+$/, '')}/restapi`;
  } else if (isSandbox()) {
    cachedApiBase = 'https://demo.docusign.net/restapi';
  } else {
    const res = await fetch(`https://${authHost()}/oauth/userinfo`, { headers: await authHeaders() });
    if (!res.ok) throw new Error(`DocuSign userinfo request failed: ${res.status} ${res.statusText}`);
    cachedApiBase = apiBaseFromUserInfo((await res.json()) as UserInfoResponse, requireEnv('DOCUSIGN_ACCOUNT_ID'));
  }
  return cachedApiBase;
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
  // certificate=true: the hashed PDF always includes the certificate of
  // completion, independent of the account's default.
  const url = `${await apiBaseUrl()}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/documents/combined?certificate=true`;
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
  const url = `${await apiBaseUrl()}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/recipients`;
  const res = await fetch(url, {
    headers: { ...(await authHeaders()), Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch recipients for ${envelopeId}: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as RecipientsResponse;
  // Only recipients DocuSign reports as having signed. deliveredDateTime is when
  // the envelope reached them, not a signing time, so it is never substituted.
  return (body.signers ?? [])
    .filter(signer => typeof signer.signedDateTime === 'string' && signer.signedDateTime !== '')
    .map(signer => ({
      name: signer.name ?? '',
      email: signer.email ?? '',
      signedAt: signer.signedDateTime as string,
    }));
}

// The envelope's own status and completion time, read from DocuSign rather
// than taken from the webhook body.
export async function getEnvelopeCompletion(envelopeId: string): Promise<{ status: string; completedAt?: string }> {
  const accountId = requireEnv('DOCUSIGN_ACCOUNT_ID');
  const url = `${await apiBaseUrl()}/v2.1/accounts/${accountId}/envelopes/${envelopeId}`;
  const res = await fetch(url, {
    headers: { ...(await authHeaders()), Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch envelope ${envelopeId}: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { status?: string; completedDateTime?: string };
  return { status: body.status ?? 'unknown', completedAt: body.completedDateTime };
}

export interface EmbeddedSigner {
  name: string;
  email: string;
  // Marks the recipient as embedded: DocuSign does not email them, and a
  // signing session can only be opened through createRecipientView.
  clientUserId: string;
}

// Send a one-signer envelope for embedded signing. The document is HTML, which
// DocuSign renders to PDF; the signature goes on `anchor` text.
export async function createEmbeddedEnvelope(opts: {
  signer: EmbeddedSigner;
  emailSubject: string;
  documentName: string;
  documentHtml: string;
  anchor: string;
}): Promise<string> {
  const accountId = requireEnv('DOCUSIGN_ACCOUNT_ID');
  const envelope = {
    emailSubject: opts.emailSubject,
    status: 'sent',
    documents: [
      {
        documentId: '1',
        name: opts.documentName,
        fileExtension: 'html',
        documentBase64: Buffer.from(opts.documentHtml, 'utf8').toString('base64'),
      },
    ],
    recipients: {
      signers: [
        {
          recipientId: '1',
          routingOrder: '1',
          ...opts.signer,
          tabs: {
            signHereTabs: [{ anchorString: opts.anchor, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-4' }],
          },
        },
      ],
    },
  };
  const res = await fetch(`${await apiBaseUrl()}/v2.1/accounts/${accountId}/envelopes`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) throw new Error(`Failed to create envelope: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { envelopeId?: string };
  if (typeof body.envelopeId !== 'string') throw new Error('DocuSign returned no envelopeId');
  return body.envelopeId;
}

// A short-lived, single-use URL that opens the embedded signing session.
// DocuSign redirects to returnUrl afterwards, appending ?event=<outcome>.
export async function createRecipientView(envelopeId: string, signer: EmbeddedSigner, returnUrl: string): Promise<string> {
  const accountId = requireEnv('DOCUSIGN_ACCOUNT_ID');
  const res = await fetch(`${await apiBaseUrl()}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      userName: signer.name,
      email: signer.email,
      clientUserId: signer.clientUserId,
      authenticationMethod: 'none',
      returnUrl,
    }),
  });
  if (!res.ok) throw new Error(`Failed to create signing view for ${envelopeId}: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { url?: string };
  if (typeof body.url !== 'string' || !body.url.startsWith('https://')) throw new Error('DocuSign returned no signing URL');
  return body.url;
}
