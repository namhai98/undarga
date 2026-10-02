import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { RequireFeature } from '../subscriptions/feature.guard';
import { GiftCardsService } from './giftcards.service';
import {
  adjustGiftCardSchema,
  disableGiftCardSchema,
  giftCardLookupSchema,
  giftCardQuerySchema,
  giftCardTransactionQuerySchema,
  issueGiftCardSchema,
  redeemGiftCardSchema,
  refundGiftCardSchema,
  updateGiftCardSchema,
  voidGiftCardSchema,
  type AdjustGiftCardDto,
  type DisableGiftCardDto,
  type GiftCardLookupDto,
  type GiftCardQueryDto,
  type GiftCardTransactionQueryDto,
  type IssueGiftCardDto,
  type RedeemGiftCardDto,
  type RefundGiftCardDto,
  type UpdateGiftCardDto,
  type VoidGiftCardDto,
} from './dto/giftcard.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Stored value.
 *
 * ---------------------------------------------------------------------------
 * THE CODE APPEARS EXACTLY ONCE
 * ---------------------------------------------------------------------------
 *
 * `POST /gift-cards` returns the plaintext in its response and nowhere else.
 * Only an HMAC is stored, so a database dump does not yield spendable cards and
 * no later endpoint can hand the code back. Losing it means voiding the card
 * and issuing another — the correct trade for bearer value.
 *
 * Lookup is a POST with the code in the BODY for the same reason a token is:
 * a code in a URL path lands in access logs, proxy logs and the `Referer`
 * header, and unlike a session it cannot be rotated.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO SPEND A CARD, ONE SET OF RULES
 * ---------------------------------------------------------------------------
 *
 * `POST /:id/redeem` records a redemption on its own — a service settled at
 * the desk. A PAYMENT with `method: GIFT_CARD` draws the card down inside the
 * payment's own transaction, so the two commit together. Both go through
 * `GiftCardsService.redeemWithin`: the same lock, the same checks, the same
 * ledger row. A redemption made by a payment is given back by refunding the
 * payment; `POST /:id/refund` gives back only direct redemptions, so no
 * redemption can be refunded twice.
 *
 * Nothing here is reachable from the public API. The ledger is staff-only.
 */
@ApiTags('gift-cards')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/gift-cards', version: '1' })
@RequireFeature('GIFT_CARDS')
@AllowPlatformAccess()
export class GiftCardsController {
  constructor(private readonly giftCards: GiftCardsService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_READ)
  @ApiOperation({
    summary: 'List gift cards',
    description:
      '`search` matches a full code (exact, by hash — codes are never stored), the last four ' +
      'characters, or the owning customer or recipient by name, phone or email. `status` is the ' +
      'effective status: an ACTIVE card past its expiry is EXPIRED.',
  })
  async list(@Query(new ZodValidationPipe(giftCardQuerySchema)) query: GiftCardQueryDto) {
    return this.giftCards.list(query);
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_ISSUE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Issue a gift card',
    description:
      'Returns the plaintext code ONCE, in `data.code`. It is not stored and cannot be ' +
      'retrieved again. Omit `expiresAt` for a card that never expires, which is the safe ' +
      'default — expiry on stored value is restricted in many jurisdictions.',
  })
  @ApiResponse({ status: 201, description: 'Issued. `data.code` will not be shown again.' })
  async issue(@Body(new ZodValidationPipe(issueGiftCardSchema)) dto: IssueGiftCardDto) {
    return this.giftCards.issue(dto);
  }

  @Post('lookup')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_READ)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check a card by its code, without spending it',
    description:
      'What the till calls before taking a payment. A wrong code, another company’s card and ' +
      'an expired card are indistinguishable in the response — anything else is an oracle for ' +
      'guessing codes.',
  })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND — no usable card for that code.' })
  async lookup(@Body(new ZodValidationPipe(giftCardLookupSchema)) dto: GiftCardLookupDto) {
    return this.giftCards.lookup(dto.code);
  }

  @Get(':giftCardId')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_READ)
  @ApiOperation({ summary: 'One gift card' })
  async find(@Param('giftCardId', uuidParam) giftCardId: string) {
    return this.giftCards.findById(giftCardId);
  }

  @Patch(':giftCardId')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_ISSUE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update a gift card',
    description:
      'Owner (`issuedToCustomerId`, `null` to detach), expiry (`null` = never; future dates only) ' +
      'and recipient details. The balance and currency cannot be changed here — the balance ' +
      'moves only through the ledger — and sending them is a 400. A voided card is 409.',
  })
  @ApiResponse({ status: 404, description: 'Card, or the customer to assign, not in this company.' })
  async update(
    @Param('giftCardId', uuidParam) giftCardId: string,
    @Body(new ZodValidationPipe(updateGiftCardSchema)) dto: UpdateGiftCardDto,
  ) {
    return this.giftCards.update(giftCardId, dto);
  }

  @Post(':giftCardId/disable')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_ISSUE)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Disable a gift card',
    description:
      'Blocks every redemption and keeps the balance. Reversible with `/enable`, which needs ' +
      '`giftcard:adjust`: stopping a card is cheap to allow, restarting one is not.',
  })
  @ApiResponse({ status: 409, description: 'Already disabled, or voided.' })
  async disable(
    @Param('giftCardId', uuidParam) giftCardId: string,
    @Body(new ZodValidationPipe(disableGiftCardSchema)) dto: DisableGiftCardDto,
  ) {
    return this.giftCards.disable(giftCardId, dto.reason);
  }

  @Post(':giftCardId/enable')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_ADJUST)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-enable a disabled gift card' })
  @ApiResponse({ status: 409, description: 'The card is not disabled.' })
  async enable(@Param('giftCardId', uuidParam) giftCardId: string) {
    return this.giftCards.enable(giftCardId);
  }

  @Get(':giftCardId/balance')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_READ)
  @ApiOperation({
    summary: 'Current balance and whether the card can be spent now',
    description: '`problemCode` says why not: DISABLED, VOID, EXPIRED, NO_BALANCE, NOT_ACTIVATED.',
  })
  async balance(@Param('giftCardId', uuidParam) giftCardId: string) {
    return this.giftCards.balance(giftCardId);
  }

  @Get(':giftCardId/transactions')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_READ)
  @ApiOperation({
    summary: 'The append-only ledger for this card',
    description:
      'Every balance change (ISSUE, REDEEM, REFUND, ADJUSTMENT, VOID), newest first, each ' +
      'carrying the balance it produced. REDEEM rows also say how much of them can still be ' +
      'refunded. This is the answer to “where did my money go”.',
  })
  async transactions(
    @Param('giftCardId', uuidParam) giftCardId: string,
    @Query(new ZodValidationPipe(giftCardTransactionQuerySchema)) query: GiftCardTransactionQueryDto,
  ) {
    return this.giftCards.listTransactions(giftCardId, query);
  }

  @Post(':giftCardId/redeem')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_REDEEM)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Spend part of a card',
    description:
      'Never partial: more than the balance is refused, as is a disabled, voided or expired card ' +
      '(400 GIFT_CARD_NOT_USABLE, `details.reason` says which). With `appointmentId`, a card ' +
      'that belongs to a customer can only be spent on that customer’s booking. Concurrent ' +
      'redemptions of one card are serialised; send `idempotencyKey` so a retry cannot spend twice.',
  })
  @ApiResponse({ status: 400, description: 'GIFT_CARD_NOT_USABLE or VALIDATION_FAILED.' })
  async redeem(
    @Param('giftCardId', uuidParam) giftCardId: string,
    @Body(new ZodValidationPipe(redeemGiftCardSchema)) dto: RedeemGiftCardDto,
  ) {
    return this.giftCards.redeem(giftCardId, dto);
  }

  @Post(':giftCardId/refund')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_REDEEM)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Give back all or part of one redemption',
    description:
      'Points at the REDEEM row it reverses and can never give back more than that row took. ' +
      'A redemption made by a payment is refunded by refunding the payment instead.',
  })
  @ApiResponse({
    status: 400,
    description: 'GIFT_CARD_NOT_USABLE — already refunded, too much, or a voided card.',
  })
  async refund(
    @Param('giftCardId', uuidParam) giftCardId: string,
    @Body(new ZodValidationPipe(refundGiftCardSchema)) dto: RefundGiftCardDto,
  ) {
    return this.giftCards.refund(giftCardId, dto);
  }

  @Get(':giftCardId/verify')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_READ)
  @ApiOperation({
    summary: 'Replay the ledger and compare it with the stored balance',
    description:
      'Because every transaction records the balance it produced, the ledger is self-checking. ' +
      'This exists so the first response to “I think gift cards are broken” is evidence rather ' +
      'than a shrug.',
  })
  async verify(@Param('giftCardId', uuidParam) giftCardId: string) {
    return this.giftCards.verifyLedger(giftCardId);
  }

  @Post(':giftCardId/adjust')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_ADJUST)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Manually correct a balance',
    description:
      'A separate permission from issuing, because this writes money onto a card without ' +
      'anybody paying for it. A reason is required and the database refuses an adjustment ' +
      'without one.',
  })
  async adjust(
    @Param('giftCardId', uuidParam) giftCardId: string,
    @Body(new ZodValidationPipe(adjustGiftCardSchema)) dto: AdjustGiftCardDto,
  ) {
    return this.giftCards.adjust(giftCardId, dto);
  }

  @Post(':giftCardId/void')
  @RequirePermission(COMPANY_PERMISSIONS.GIFTCARD_ADJUST)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Cancel a card for good',
    description:
      'Issued in error, or paid out another way. Any remaining balance is written off as a VOID ' +
      'row rather than silently zeroed, so the liability leaving the books explains itself. To ' +
      'stop a card temporarily, disable it instead.',
  })
  async void(
    @Param('giftCardId', uuidParam) giftCardId: string,
    @Body(new ZodValidationPipe(voidGiftCardSchema)) dto: VoidGiftCardDto,
  ): Promise<void> {
    await this.giftCards.void(giftCardId, dto.reason);
  }
}
