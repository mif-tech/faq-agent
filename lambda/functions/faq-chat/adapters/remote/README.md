# remote-v1 RAG contract

`remote-v1` is the JSON-only boundary between the reusable FAQ application and a
server-owned retrieval/generation implementation. The public-safe files define the wire contract;
the canonical repository also contains a process-local reference seam. Nothing here performs
HTTP, authentication, signing, quota storage, or deployment wiring.

## Why retrieve and generate are separate

The first operation retrieves privately and returns a random, short-lived UUIDv4
`sessionToken`. The
second operation consumes that token once and returns the final public FAQ response. This split
makes no-match, expiry, and generation idempotency explicit without returning the KB projection
to the caller.

A single `/v1/answer` operation would remove the token and one round trip, but it would be a
different contract. It is not silently substituted for `remote-v1`.

## Information boundary

The retrieve response contains only:

- `contractVersion`
- `ok`
- a non-semantic opaque token
- token expiry metadata

Only a successful generate response contains semantic server output: the final
`{ answer, answerable, responseType, sources }` envelope. Sources contain the public
`entryId`, topic, and optional publishable URL.

The generate request carries the bare sanitized `currentQuestion`, one post-sanitization `user`
message (which may serialize earlier user turns), an idempotency key, and the remaining deadline
budget. The message must end with the exact `currentQuestion`, binding the composite prompt input
to the retrieval question. It cannot carry `system` or forged `assistant` messages.

The wire contract never contains a KB block or fragment, result counts, ranks, scores,
retrieval telemetry/trace, model prompt/schema/callback, raw model output, token usage, debug
details, provider exception, or caller-supplied `tenantId`. A future authenticated boundary must
derive tenant identity from the authenticated principal, not from either DTO.

## Runtime validation and versioning

`contract.ts` validates both requests and responses without a runtime dependency. Validation is
strict: the version, exact keys, nested arrays/objects, scalar types and bounds, UUIDv4 token,
operation-specific error codes, and final response cross-field rules are checked. Optional keys
present as `undefined` are invalid because `undefined` is not JSON. Unknown fields fail closed as
`invalid_contract`.

Successful KB answers contain one to five unique sources, have no URL in the answer text
(checked with the same `containsUrl()` the envelope guard uses), and publish only HTTPS source
URLs outside `notion.so`. The URL check is deliberately asymmetric: it applies to `kb_answer`
only. Refusal texts are server-owned fixed messages, so they are not re-checked on the wire. Refusals have exactly one of three shapes:
plain, `scopeFallback: true`, or technical
`failureKind: "envelope_invalid", retryable: true`.

Do not add optional fields to `remote-v1` after release. A wire-shape change requires a new
contract version and an explicit compatibility policy.

Defined errors are `no_match`, `expired_token`, `quota_exceeded`, `kill_switch`,
`invalid_contract`, `deadline_exceeded`, `retrieval_failed`, and `generation_failed`. Retryability
is fixed by the contract. Only `quota_exceeded` carries `retryAfterMs`, and it is required there.
Error DTOs never carry internal messages or quota state.
`retryable: true` means the caller may restart the workflow, normally from `retrieve`; it does not
promise that re-sending a consumed token will execute generation again. A matching idempotency key
replays the cached result, while a different key receives `expired_token`.

## Opaque-session lifecycle

`createInProcessOpaqueSessionFaqRagPort` composes the existing low-level retrieval, answer-prompt,
and generation ports on the server side:

1. `retrieve` keeps the complete retrieval result in a private `Map` keyed by `randomUUID()` and
   returns only the token and expiry.
2. `generate` verifies that the current question is bound to the session, atomically consumes the
   token in-process, builds the private prompt, resolves source refs, and returns the final public
   envelope.
3. The same idempotency key and payload share an in-flight/cached result, while the same key with a
   different payload fails as `invalid_contract`.
4. Reusing a consumed token with another key fails as `expired_token`.

The Map implementation is deliberately a deterministic seam, not a deployable distributed
idempotency guarantee. The maps are also unbounded and `prune` is a linear scan on each request:
without the authentication, rate limiting, and quota that the transport PR adds, a caller can grow
memory and prune cost linearly just by calling `retrieve`. Treat bounded storage (max entries or
LRU, plus per-tenant quota) as a hard precondition of the HTTP adapter PR, together with the
atomic shared store below. Expiry is enforced logically at access time; physical cleanup is lazy and
runs on later requests. Its TTL, one-time use, and replay cache do not survive a cold start and are
not atomic across concurrent server instances. Each caller wait and provider call has a logical
deadline, but physical cancellation still depends on the low-level provider honoring its
`timeoutMs`. The later managed API must replace the Maps with an atomic shared store before
claiming cross-instance double-charge protection. That store must namespace sessions and
idempotency keys by the authenticated tenant derived by the transport, never by a DTO tenant
claim.

Structured output is enabled only when both the selected model's server-owned allowlist decision
and the generation port capability permit it. The wire caller cannot choose the model or schema.

`opaque-session.ts` and `production-rag.ts` are canonical-only server precursors and are
intentionally absent from public sync. The public boundary contains the higher-level port, DTO
validator, documentation, golden fixture, and wire-contract test only. Neither server precursor is
wired into the current handler or `FAQ_PORTS_PROFILE` in this change.
