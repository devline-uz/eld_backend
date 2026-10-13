import { Global, Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';
import { PushTokenRepository } from './push-token.repository';
import { PushService } from './push.service';

@Global()
@Module({ providers: [FirebaseService, PushService, PushTokenRepository], exports: [FirebaseService, PushService] })
export class FirebaseModule {}
