# Phase 2.5M.1 - Secure Password Change Report

## Files Changed

- `src/modules/me/me.routes.js`
- `src/modules/me/me.controller.js`
- `src/modules/users/user.controller.js`
- `src/modules/users/user.routes.js`
- `src/modules/users/user.service.js`
- `src/tests/mePassword.test.js`
- `docs/BASELINE_ARCHITECTURE.md`
- `docs/PHASE_2_FEATURE_TODO.md`
- `docs/PHASE_2_5M1_PASSWORD_CHANGE_REPORT.md`

## Route Added

- `PATCH /api/me/password`

## Request Shape

```json
{
  "currentPassword": "old password",
  "newPassword": "new password"
}
```

## Response Shape

```json
{
  "success": true,
  "message": "Password updated successfully."
}
```

No password field, password hash, or user payload is returned.

## Validation Behavior

- Requires authenticated active user through existing `/api/me` middleware.
- Requires `currentPassword`.
- Requires `newPassword`.
- Requires `newPassword` to be at least 8 characters with uppercase, lowercase, and number characters.
- Rejects unchanged password values.
- Rejects wrong current passwords with a safe authentication error.

## Security Behavior

- The service loads the current user with `+password` only inside the password-change flow.
- `currentPassword` is verified using the existing `comparePassword` model method.
- `newPassword` is saved through the existing User model pre-save hashing hook.
- The old self-profile update path no longer accepts `password`.
- Password values are not logged by this flow; the shared validator redacts password-like validation values.

## Frontend Behavior

- Frontend calls `PATCH /api/me/password` through the new profile API helper.
- The modal collects current, new, and confirm password.
- Success is shown only after backend confirmation.

## Tests/Checks Run

- `npm.cmd test -- mePassword.test.js --runInBand` - passed.
- `npm.cmd run lint` - passed.
- `npm.cmd test -- --runInBand` - passed.
- `git diff --check` - passed.

## Remaining Warnings

- Existing JWT sessions are not revoked because the backend has no session revocation model.
- Full backend test output includes existing noisy audit/fulfillment console logs and a duplicate schema index warning unrelated to this change.
- Git reported LF/CRLF conversion warnings during diff-check, but no whitespace errors.
- The backend test run left untracked upload fixture files under `uploads/`; cleanup was not performed after the environment rejected the requested delete approval.

## Completion Status

- Phase 2.5M.1 backend work is complete.
