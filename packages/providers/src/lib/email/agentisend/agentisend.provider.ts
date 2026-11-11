import { createHmac, timingSafeEqual } from 'node:crypto';
import { EmailProviderIdEnum } from '@novu/shared';
import {
  ChannelTypeEnum,
  CheckIntegrationResponseEnum,
  EmailEventStatusEnum,
  IAttachmentOptions,
  ICheckIntegrationResponse,
  IEmailEventBody,
  IEmailOptions,
  IEmailProvider,
  ISendMessageSuccessResponse,
} from '@novu/stateless';
import { BaseProvider, CasingEnum } from '../../../base.provider';
import { WithPassthrough } from '../../../utils/types';

const DEFAULT_BASE_URL = 'https://api.agentisend.com';
// AgentiSend rejects a signed delivery older than five minutes; mirror that window.
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export interface AgentisendAttachment {
  filename: string;
  content: string;
  content_type?: string;
  content_id?: string;
}

export interface AgentisendSendRequest {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  headers?: Record<string, string>;
  attachments?: AgentisendAttachment[];
  [key: string]: unknown;
}

interface AgentisendError {
  code?: string;
  message?: string;
  fix?: string;
}

// The native envelope AgentiSend POSTs to a webhook endpoint.
export interface AgentisendWebhookEvent {
  id: string;
  type: string;
  occurred_at: string;
  account_id?: string;
  data: {
    email_id?: string;
    recipient?: string;
    bounce?: { type?: string; sub_type?: string; diagnostic_code?: string };
    [key: string]: unknown;
  };
}

export class AgentisendEmailProvider extends BaseProvider implements IEmailProvider {
  id = EmailProviderIdEnum.AgentiSend;
  // The REST API is snake_case (reply_to, content_type, content_id).
  protected casing: CasingEnum = CasingEnum.SNAKE_CASE;
  channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;
  private readonly baseUrl: string;

  constructor(
    private config: {
      apiKey: string;
      from: string;
      senderName?: string;
      webhookSigningKey?: string;
      baseUrl?: string;
    }
  ) {
    super();
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async sendMessage(
    options: IEmailOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const senderName = options.senderName || this.config.senderName;
    const fromAddress = options.from || this.config.from;

    const mailData: AgentisendSendRequest = {
      from: senderName ? `${senderName} <${fromAddress}>` : fromAddress,
      to: options.to,
      subject: options.subject,
      ...(options.html ? { html: options.html } : {}),
      ...(options.text ? { text: options.text } : {}),
      ...(options.cc?.length ? { cc: options.cc } : {}),
      ...(options.bcc?.length ? { bcc: options.bcc } : {}),
      ...(options.replyTo ? { reply_to: options.replyTo } : {}),
      ...(options.headers && Object.keys(options.headers).length ? { headers: options.headers } : {}),
      ...(options.attachments?.length ? { attachments: this.mapAttachments(options.attachments) } : {}),
    };

    const body = this.transform<AgentisendSendRequest>(bridgeProviderData, mailData).body;

    // Novu's message id doubles as the idempotency key, so a retried job replays
    // the first send instead of mailing the subscriber twice.
    const response = await this.request<{ id: string }>('POST', '/emails', body, options.id);

    return {
      id: response.id,
      date: new Date().toISOString(),
    };
  }

  async checkIntegration(_options: IEmailOptions): Promise<ICheckIntegrationResponse> {
    // Validate the key with a read instead of a probe send.
    const response = await fetch(`${this.baseUrl}/domains`, {
      method: 'GET',
      headers: this.headers(),
    }).catch((error: Error) => error);

    if (response instanceof Error) {
      return { success: false, message: response.message, code: CheckIntegrationResponseEnum.FAILED };
    }

    if (response.ok) {
      return { success: true, message: 'Integrated successfully!', code: CheckIntegrationResponseEnum.SUCCESS };
    }

    const error = await this.readError(response);

    // A sending-only key cannot list domains but is valid for sending.
    if (error.code === 'restricted_api_key') {
      return { success: true, message: 'Integrated successfully!', code: CheckIntegrationResponseEnum.SUCCESS };
    }

    return {
      success: false,
      message: error.message ?? `AgentiSend responded with ${response.status}`,
      code:
        response.status === 401 || response.status === 403
          ? CheckIntegrationResponseEnum.BAD_CREDENTIALS
          : CheckIntegrationResponseEnum.FAILED,
    };
  }

  getMessageId(body: AgentisendWebhookEvent | AgentisendWebhookEvent[]): string[] {
    return this.toEvents(body)
      .map((event) => event.data?.email_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  parseEventBody(
    body: AgentisendWebhookEvent | AgentisendWebhookEvent[],
    identifier: string
  ): IEmailEventBody | undefined {
    const event = this.toEvents(body).find((item) => item.data?.email_id === identifier);

    if (!event) {
      return undefined;
    }

    const status = this.getStatus(event.type);

    if (status === undefined) {
      return undefined;
    }

    const response = event.data.bounce?.diagnostic_code;

    return {
      status,
      date: event.occurred_at ?? new Date().toISOString(),
      externalId: event.data.email_id,
      ...(response ? { response } : {}),
      row: JSON.stringify(event),
    };
  }

  async verifySignature({
    rawBody,
    headers = {},
  }: {
    rawBody: unknown;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  }): Promise<{ success: boolean; message?: string }> {
    const secret = this.config.webhookSigningKey;

    if (!secret) {
      return { success: true, message: 'AgentiSend signature verification is not configured' };
    }

    const header = this.getHeaderValue(headers, 'x-agentisend-signature');

    if (!header) {
      return { success: false, message: 'Missing x-agentisend-signature header' };
    }

    if (rawBody === undefined || rawBody === null) {
      return { success: false, message: 'Body is undefined' };
    }

    // Header format: t=<unix seconds>,v1=<hex>[,v1=<hex>] (one v1 per secret during a rotation).
    const parts = header.split(',').map((part) => part.trim());
    const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
    const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));

    if (!timestamp || signatures.length === 0) {
      return { success: false, message: 'Malformed x-agentisend-signature header' };
    }

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));

    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
      return { success: false, message: 'AgentiSend signature timestamp is outside the tolerance window' };
    }

    const payload = this.rawBodyToString(rawBody);

    if (payload === undefined) {
      return { success: false, message: 'Unsupported raw body type' };
    }

    const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest();
    const matches = signatures.some((signature) => {
      const candidate = Buffer.from(signature, 'hex');

      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });

    return matches
      ? { success: true, message: 'AgentiSend signature verification successful' }
      : { success: false, message: 'AgentiSend signature does not match' };
  }

  private async request<T>(method: string, path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await this.readError(response);
      const fix = error.fix ? ` ${error.fix}` : '';

      throw new Error(`${error.message ?? `AgentiSend responded with ${response.status}`}${fix}`);
    }

    return (await response.json()) as T;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'User-Agent': 'novu-agentisend-provider',
    };
  }

  private async readError(response: Response): Promise<AgentisendError> {
    try {
      const json = (await response.json()) as AgentisendError & { error?: AgentisendError };

      return json.error && typeof json.error === 'object' ? json.error : json;
    } catch {
      return {};
    }
  }

  private mapAttachments(attachments: IAttachmentOptions[]): AgentisendAttachment[] {
    return attachments
      .filter((attachment) => attachment.file)
      .map((attachment) => ({
        filename: attachment.name ?? 'attachment',
        content: Buffer.from(attachment.file).toString('base64'),
        ...(attachment.mime ? { content_type: attachment.mime } : {}),
        ...(attachment.cid ? { content_id: attachment.cid } : {}),
      }));
  }

  private rawBodyToString(rawBody: unknown): string | undefined {
    if (typeof rawBody === 'string') {
      return rawBody;
    }

    if (rawBody instanceof Uint8Array) {
      return Buffer.from(rawBody).toString('utf8');
    }

    return undefined;
  }

  private toEvents(body: AgentisendWebhookEvent | AgentisendWebhookEvent[]): AgentisendWebhookEvent[] {
    if (Array.isArray(body)) {
      return body;
    }

    return body ? [body] : [];
  }

  private getStatus(event: string): EmailEventStatusEnum | undefined {
    switch (event) {
      case 'email.sent':
        return EmailEventStatusEnum.SENT;
      case 'email.delivered':
        return EmailEventStatusEnum.DELIVERED;
      case 'email.delivery_delayed':
        return EmailEventStatusEnum.DELAYED;
      case 'email.bounced':
        return EmailEventStatusEnum.BOUNCED;
      case 'email.complained':
        return EmailEventStatusEnum.COMPLAINT;
      case 'email.suppressed':
      case 'email.failed':
      case 'email.canceled':
        return EmailEventStatusEnum.DROPPED;
      case 'email.opened':
        return EmailEventStatusEnum.OPENED;
      case 'email.clicked':
        return EmailEventStatusEnum.CLICKED;
      default:
        return undefined;
    }
  }

  private getHeaderValue(headers: Record<string, string>, headerName: string): string | undefined {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === headerName.toLowerCase());

    return key ? headers[key] : undefined;
  }
}
