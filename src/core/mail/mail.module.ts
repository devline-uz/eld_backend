import { Global, Module } from '@nestjs/common';
import { TRANSACTIONAL_MAIL } from './mail.port';
import { SmtpMailTransport } from './smtp-mail.transport';

@Global()
@Module({
  providers: [{ provide: TRANSACTIONAL_MAIL, useClass: SmtpMailTransport }],
  exports: [TRANSACTIONAL_MAIL],
})
export class MailModule {}
