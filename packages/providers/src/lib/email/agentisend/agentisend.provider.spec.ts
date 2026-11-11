import { createHmac } from 'node:crypto';
import { CheckIntegrationResponseEnum, EmailEventStatusEnum, IEmailOptions } from '@novu/stateless';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentisendEmailProvider, AgentisendWebhookEvent } from './agentisend.provider';

const mockConfig = {
  apiKey: 'as_test_key',
  from: 'test@test.com',
};

const mockNovuMessage: IEmailOptions = {
  id: 'novu-message-id',
  from: 'test@test.com',
  to: ['subscriber@test.com'],
  html: '<div> Mail Content </div>',
  text: 'Mail Content',
  subject: 'Test subject',
  replyTo: 'no-reply@novu.co',
  attachments: [{ mime: 'text/plain', file: Buffer.from('test'), name: 'test.txt' }],
};

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    );
  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];

  return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sendMessage', () => {
  test('posts the mapped message to /emails with the bearer key and idempotency key', async () => {
    const fetchMock = mockFetch(201, { id: 'agentisend-email-id', simulated: false, warnings: [] });
    const provider = new AgentisendEmailProvider(mockConfig);

    const result = await provider.sendMessage(mockNovuMessage);

    const { url, init, body } = requestOf(fetchMock);
    expect(url).toBe('https://api.agentisend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer as_test_key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'novu-message-id',
    });
    expect(body).toEqual({
      from: 'test@test.com',
      to: ['subscriber@test.com'],
      subject: 'Test subject',
      html: '<div> Mail Content </div>',
      text: 'Mail Content',
      reply_to: 'no-reply@novu.co',
      attachments: [
        { filename: 'test.txt', content: Buffer.from('test').toString('base64'), content_type: 'text/plain' },
      ],
    });
    expect(result.id).toBe('agentisend-email-id');
    expect(typeof result.date).toBe('string');
  });

  test('formats the sender name from the message or the integration', async () => {
    const fetchMock = mockFetch(201, { id: 'id-1' });
    const provider = new AgentisendEmailProvider({ ...mockConfig, senderName: 'Acme' });

    await provider.sendMessage({ ...mockNovuMessage, from: undefined });
    expect(requestOf(fetchMock).body.from).toBe('Acme <test@test.com>');

    await provider.sendMessage({ ...mockNovuMessage, senderName: 'Override' });
    expect(requestOf(fetchMock, 1).body.from).toBe('Override <test@test.com>');
  });

  test('keeps the inline image content id', async () => {
    const fetchMock = mockFetch(201, { id: 'id-1' });
    const provider = new AgentisendEmailProvider(mockConfig);

    await provider.sendMessage({
      ...mockNovuMessage,
      attachments: [{ mime: 'image/png', file: Buffer.from('png'), name: 'logo.png', cid: 'logo' }],
    });

    expect(requestOf(fetchMock).body.attachments[0]).toEqual({
      filename: 'logo.png',
      content: Buffer.from('png').toString('base64'),
      content_type: 'image/png',
      content_id: 'logo',
    });
  });

  test('merges provider overrides from the bridge', async () => {
    const fetchMock = mockFetch(201, { id: 'id-1' });
    const provider = new AgentisendEmailProvider(mockConfig);

    await provider.sendMessage(mockNovuMessage, {
      tags: { workflow: 'welcome' },
      _passthrough: { body: { topic_id: 'topic-1' } },
    });

    expect(requestOf(fetchMock).body).toMatchObject({ tags: { workflow: 'welcome' }, topic_id: 'topic-1' });
  });

  test('honours a custom base URL', async () => {
    const fetchMock = mockFetch(201, { id: 'id-1' });
    const provider = new AgentisendEmailProvider({ ...mockConfig, baseUrl: 'https://eu.example.test/' });

    await provider.sendMessage(mockNovuMessage);

    expect(requestOf(fetchMock).url).toBe('https://eu.example.test/emails');
  });

  test('throws the API message and its fix on a refusal', async () => {
    mockFetch(422, {
      statusCode: 422,
      name: 'domain_not_verified',
      message: 'The from domain is not verified.',
      error: {
        code: 'domain_not_verified',
        message: 'The from domain is not verified.',
        fix: 'Verify the domain first.',
      },
    });
    const provider = new AgentisendEmailProvider(mockConfig);

    await expect(provider.sendMessage(mockNovuMessage)).rejects.toThrow(
      'The from domain is not verified. Verify the domain first.'
    );
  });
});

describe('checkIntegration', () => {
  test('succeeds on a readable key without sending mail', async () => {
    const fetchMock = mockFetch(200, { data: [] });
    const provider = new AgentisendEmailProvider(mockConfig);

    const result = await provider.checkIntegration(mockNovuMessage);

    expect(requestOf(fetchMock).url).toBe('https://api.agentisend.com/domains');
    expect(requestOf(fetchMock).init.method).toBe('GET');
    expect(result).toMatchObject({ success: true, code: CheckIntegrationResponseEnum.SUCCESS });
  });

  test('accepts a sending-only key', async () => {
    mockFetch(403, { error: { code: 'restricted_api_key', message: 'This key can only send.' } });
    const provider = new AgentisendEmailProvider(mockConfig);

    expect(await provider.checkIntegration(mockNovuMessage)).toMatchObject({ success: true });
  });

  test('reports bad credentials', async () => {
    mockFetch(403, { error: { code: 'invalid_api_key', message: 'API key is invalid or revoked.' } });
    const provider = new AgentisendEmailProvider(mockConfig);

    expect(await provider.checkIntegration(mockNovuMessage)).toEqual({
      success: false,
      message: 'API key is invalid or revoked.',
      code: CheckIntegrationResponseEnum.BAD_CREDENTIALS,
    });
  });
});

describe('webhooks', () => {
  const event: AgentisendWebhookEvent = {
    id: 'evt-1',
    type: 'email.bounced',
    occurred_at: '2026-09-25T12:09:39.357Z',
    account_id: 'acct-1',
    data: {
      email_id: 'email-1',
      recipient: 'subscriber@test.com',
      bounce: { type: 'Permanent', sub_type: 'General', diagnostic_code: 'smtp; 550 5.1.1 user unknown' },
    },
  };

  test('reads the message id', () => {
    const provider = new AgentisendEmailProvider(mockConfig);

    expect(provider.getMessageId(event)).toEqual(['email-1']);
    expect(provider.getMessageId([event, { ...event, data: { email_id: 'email-2' } }])).toEqual(['email-1', 'email-2']);
  });

  test('maps a bounce with its diagnostic code', () => {
    const provider = new AgentisendEmailProvider(mockConfig);

    expect(provider.parseEventBody(event, 'email-1')).toEqual({
      status: EmailEventStatusEnum.BOUNCED,
      date: '2026-09-25T12:09:39.357Z',
      externalId: 'email-1',
      response: 'smtp; 550 5.1.1 user unknown',
      row: JSON.stringify(event),
    });
  });

  test.each([
    ['email.sent', EmailEventStatusEnum.SENT],
    ['email.delivered', EmailEventStatusEnum.DELIVERED],
    ['email.delivery_delayed', EmailEventStatusEnum.DELAYED],
    ['email.complained', EmailEventStatusEnum.COMPLAINT],
    ['email.suppressed', EmailEventStatusEnum.DROPPED],
    ['email.failed', EmailEventStatusEnum.DROPPED],
    ['email.opened', EmailEventStatusEnum.OPENED],
    ['email.clicked', EmailEventStatusEnum.CLICKED],
  ])('maps %s', (type, status) => {
    const provider = new AgentisendEmailProvider(mockConfig);

    expect(provider.parseEventBody({ ...event, type, data: { email_id: 'email-1' } }, 'email-1')?.status).toBe(status);
  });

  test('ignores unknown types and other messages', () => {
    const provider = new AgentisendEmailProvider(mockConfig);

    expect(provider.parseEventBody({ ...event, type: 'domain.verified' }, 'email-1')).toBeUndefined();
    expect(provider.parseEventBody(event, 'email-other')).toBeUndefined();
  });

  describe('verifySignature', () => {
    const secret = 'whsec_test';
    const rawBody = JSON.stringify(event);
    const now = 1_790_000_000;
    const sign = (t: number, s = secret) => createHmac('sha256', s).update(`${t}.${rawBody}`).digest('hex');

    test('accepts a valid signature, including one of several during a rotation', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
      const provider = new AgentisendEmailProvider({ ...mockConfig, webhookSigningKey: secret });

      expect(
        await provider.verifySignature({ rawBody, headers: { 'X-AgentiSend-Signature': `t=${now},v1=${sign(now)}` } })
      ).toMatchObject({ success: true });
      expect(
        await provider.verifySignature({
          rawBody: Buffer.from(rawBody),
          headers: { 'x-agentisend-signature': `t=${now},v1=${sign(now, 'old')},v1=${sign(now)}` },
        })
      ).toMatchObject({ success: true });
    });

    test('rejects a wrong signature, a stale timestamp and a missing header', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
      const provider = new AgentisendEmailProvider({ ...mockConfig, webhookSigningKey: secret });

      expect(
        await provider.verifySignature({
          rawBody,
          headers: { 'x-agentisend-signature': `t=${now},v1=${sign(now, 'x')}` },
        })
      ).toMatchObject({ success: false });
      expect(
        await provider.verifySignature({
          rawBody,
          headers: { 'x-agentisend-signature': `t=${now - 600},v1=${sign(now - 600)}` },
        })
      ).toMatchObject({ success: false });
      expect(await provider.verifySignature({ rawBody, headers: {} })).toMatchObject({ success: false });
    });

    test('passes when no signing key is configured', async () => {
      const provider = new AgentisendEmailProvider(mockConfig);

      expect(await provider.verifySignature({ rawBody, headers: {} })).toMatchObject({ success: true });
    });
  });
});
