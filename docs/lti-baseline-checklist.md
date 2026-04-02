# LTI Baseline Checklist and Rollback

Date: 2026-04-02
Branch: feat/lti-entry-implementation

## Baseline Validation (Pre-LTI)

- [ ] Non-LTI login works with Firebase email/password
- [ ] Dashboard/home loads after login
- [ ] Exam-bank browse/filter/search flow unchanged
- [ ] Core API actions still succeed (parse-exam, send email flows)
- [ ] Existing user data remains visible

## Feature Flag

- VaultAU server-side gate: `LTI_ENTRY_ENABLED`
- Default: `false`
- LTI exchange endpoint returns `403 lti_entry_disabled` when disabled

## Rollback Rule

If any production incident occurs:

1. Set `LTI_ENTRY_ENABLED=false` in Netlify environment.
2. Redeploy/refresh runtime environment.
3. Verify regular Firebase email/password login works.
4. Confirm LTI launch attempts fail closed and do not affect existing UX.

Expected rollback outcome: existing workflow stays online with no downtime.
