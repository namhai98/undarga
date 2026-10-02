import { Inject, Injectable } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import { NOTIFICATION_PROVIDERS, type NotificationProvider } from './notification-provider';

/**
 * Channel → provider. The dispatcher asks it whether an address is deliverable;
 * the worker asks it who sends.
 *
 * `NOTIFICATION_PROVIDERS` is a multi-provider array and the LAST registration
 * for a channel wins, so a real vendor added after the mock takes over that
 * channel without a conditional anywhere.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly byChannel = new Map<NotificationChannel, NotificationProvider>();

  constructor(@Inject(NOTIFICATION_PROVIDERS) providers: readonly NotificationProvider[]) {
    for (const provider of providers) {
      for (const channel of provider.channels) this.byChannel.set(channel, provider);
    }
  }

  forChannel(channel: NotificationChannel): NotificationProvider | null {
    return this.byChannel.get(channel) ?? null;
  }

  /** False when no provider serves the channel at all. */
  isValidAddress(channel: NotificationChannel, address: string): boolean {
    return this.forChannel(channel)?.isValidAddress(address) ?? false;
  }
}
