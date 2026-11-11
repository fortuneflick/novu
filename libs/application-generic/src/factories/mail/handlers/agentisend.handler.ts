import { AgentisendEmailProvider } from '@novu/providers';
import { ChannelTypeEnum, EmailProviderIdEnum, IConfigurations, ICredentials } from '@novu/shared';
import { BaseEmailHandler } from './base.handler';

export class AgentisendHandler extends BaseEmailHandler {
  constructor() {
    super(EmailProviderIdEnum.AgentiSend, ChannelTypeEnum.EMAIL);
  }
  buildProvider(credentials: ICredentials & IConfigurations, from?: string) {
    this.provider = new AgentisendEmailProvider({
      from: from as string,
      apiKey: credentials.apiKey as string,
      senderName: credentials.senderName,
      webhookSigningKey: credentials.inboundWebhookSigningKey,
    });
  }
}
