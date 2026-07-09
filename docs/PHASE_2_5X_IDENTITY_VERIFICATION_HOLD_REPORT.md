# Phase 2.5X — Identity Verification Hold Report

## Summary

Implemented an admin-controlled identity verification hold for users flagged by a payment/provider support process.

No document upload, KYC file storage, or identity document handling is included in this phase.

## Backend contract

- New `User` fields:
  - `identityVerificationRequired`
  - `identityVerificationReason`
  - `identityVerificationRequestedAt`
  - `identityVerificationRequestedBy`
  - `identityVerificationClearedAt`
  - `identityVerificationClearedBy`
- Admin endpoint:
  - `PATCH /api/admin/users/:id/identity-verification`
  - body: `{ "required": true|false, "reason": "optional reason" }`
- Audit events:
  - `USER_IDENTITY_VERIFICATION_REQUIRED`
  - `USER_IDENTITY_VERIFICATION_CLEARED`

## Customer behavior

Users with `identityVerificationRequired: true` can still:

- log in;
- refresh auth/me and profile;
- view dashboard, profile, wallet, orders, and history.

They cannot:

- create product orders;
- create online wallet top-up/payment intents;
- create manual deposit requests.

Blocked actions return:

```json
{
  "success": false,
  "code": "IDENTITY_VERIFICATION_REQUIRED",
  "message": "Please contact support to verify your identity before continuing.",
  "support": {
    "type": "whatsapp",
    "phone": "+971527715868",
    "url": "https://wa.me/971527715868"
  }
}
```

## Side-effect safety

The guard runs before wallet debit/credit, order creation, payment creation, manual deposit creation, and gateway adapter calls. This keeps wallet ledger idempotency and Paymento/Network/mock gateway behavior safe.

## Frontend behavior

Customer auth/profile state now carries `identityVerificationRequired`. When active, `CustomerLayout` shows a support modal with:

- Arabic title: `مطلوب تأكيد الهوية`
- Arabic message: `لحماية حسابك وإكمال عمليات الشراء أو الشحن، يرجى التواصل مع الدعم لتأكيد الهوية.`
- WhatsApp CTA: `https://wa.me/971527715868?text=Hello%20Winnie%20Support%2C%20I%20need%20to%20verify%20my%20identity.`

Admin user management includes a hold control with reason text and enable/clear buttons.

## Tests

Added `src/tests/identityVerification.test.js` covering:

- admin enable/clear;
- audit logs;
- safe user serialization;
- login remains allowed;
- payment/order/manual-deposit blocks;
- no wallet transaction/payment/order/deposit side effects while blocked;
- clearing the hold restores payment/order flow.
