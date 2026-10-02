# `gift-cards` feature

Empty on purpose. Gift cards live in `features/billing` (`GiftCardList`,
`GiftCardDetail`, `CustomerGiftCards`), because a gift-card payment against a
discounted booking touches payments, gift cards and promotions at once — see
`features/billing/index.ts` and `docs/BILLING.md` §5.
