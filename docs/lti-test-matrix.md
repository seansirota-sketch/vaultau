# LTI Test Matrix

Date: 2026-04-02

## Launch Tests

| Scenario | Expected Result | Status | Notes |
|---|---|---|---|
| New user first LTI launch | Session exchange succeeds, Firebase custom token issued, app loads | Pending | Requires bridge token |
| Returning mapped user launch | Existing uid re-used, app loads with existing data | Pending | |
| Learner launch | Role maps to `student` and standard student behavior preserved | Pending | |
| Instructor launch | Role maps to `instructor` and backend policy can enforce elevated path | Pending | |

## Negative Tests

| Scenario | Expected Result | Status | Notes |
|---|---|---|---|
| Expired handoff token | `401 handoff_token_expired` | Pending | |
| Invalid signature | `401 invalid_handoff_signature` | Pending | |
| Unknown course mapping (when `LTI_REQUIRE_COURSE_MAP=true`) | `403 unknown_course_mapping` | Pending | |

## Compatibility Tests

| Scenario | Expected Result | Status | Notes |
|---|---|---|---|
| Non-LTI login still works | Current login page and flow unchanged | Pending | |
| Existing saved data still appears | Existing Firestore user data is visible after login | Pending | |

## Observability Checks

- Track launch success/failure counts via `lti_launch_audit`
- Track top error codes from audit records
- Monitor exchange function latency in Netlify logs
