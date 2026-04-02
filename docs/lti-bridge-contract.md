# LTI Bridge Contract (lti-tool -> VaultAU)

This repository implements the VaultAU exchange endpoint:

- `POST /.netlify/functions/lti-session-exchange`

The bridge (`lti-tool`) should mint a short-lived signed handoff token and redirect users to:

- `https://<vaultau-host>/?lti_handoff=<JWT>`

## Required Handoff Claims

- `iss`
- `sub`
- `aud`
- `iat`
- `exp`
- `jti`

## Recommended Claims

- `client_id`
- `deployment_id`
- `context_id`
- `context_title`
- `roles`
- `email`
- `name`

## Token Requirements

- Signed JWT with `alg=HS256`
- Signature key must match VaultAU env var `LTI_HANDOFF_VERIFY_KEY`
- Audience must match VaultAU env var `LTI_EXPECTED_AUDIENCE`
- Issuer must be included in `LTI_ALLOWED_ISSUERS`

## Local Debug Compatibility

Local debug may still pass query parameters in a non-production bridge mode, but production should always use `lti_handoff` token flow.
