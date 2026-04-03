# LTI Environment Variables Plan

## VaultAU (Netlify)

- `LTI_ENTRY_ENABLED`
- `LTI_ALLOWED_ISSUERS`
- `LTI_EXPECTED_AUDIENCE`
- `LTI_HANDOFF_VERIFY_KEY`
- `LTI_REQUIRE_COURSE_MAP` (optional strict mode)

## Bridge (lti-tool)

- `VAULTAU_URL`
- `LTI_HANDOFF_SIGNING_KEY`
- `LTI_HANDOFF_AUDIENCE`
- `LTI_HANDOFF_TTL_SECONDS`

## Notes

- `LTI_HANDOFF_SIGNING_KEY` (bridge) must equal `LTI_HANDOFF_VERIFY_KEY` (VaultAU).
- `LTI_HANDOFF_AUDIENCE` (bridge) must equal `LTI_EXPECTED_AUDIENCE` (VaultAU).
- Keep `LTI_ENTRY_ENABLED=false` until rollout gate is approved.
