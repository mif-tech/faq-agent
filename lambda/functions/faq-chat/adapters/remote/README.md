# remote-v1 RAG contract

`remote-v1` is the JSON-only boundary between the reusable FAQ application and a
server-owned retrieval/generation implementation. The public-safe client side contains the wire
contract and `http-client.ts`: DTO validation, optional STS AssumeRole, and SigV4 request signing
are transport concerns that can be distributed without the server implementation. The canonical
repository alone contains the server seam (`opaque-session.ts`, `opaque-session-store.ts`, and
`production-rag.ts`) and the managed `remote-rag` stack that supplies the private KB retrieval,
prompt, model, and generation implementation.
`FAQ_PORTS_PROFILE=remote` keeps the shell's input guards, smalltalk routing, settings, Q&A logging,
PII masking, and HTTP response formatting local, while delegating the retrieval, private prompt,
answer generation, and public-envelope core through that higher-level client.

The client requires `FAQ_REMOTE_RAG_BASE_URL` (HTTPS only), uses `AWS_REGION`, and signs
`execute-api` requests with SigV4. Its library seam can use the default credential chain when no
role is supplied for isolated tests, but the public lite SAM template does not expose a role-less
remote deployment. `FaqPortsProfile=remote` requires all three public SAM parameters:
`FaqRemoteRagBaseUrl`, the exact cross-account `FaqRemoteRagRoleArn`, and
`FaqRemoteRagExternalId`. The template grants the FAQ caller role only `sts:AssumeRole` on that
configured role; it does not grant direct `execute-api:Invoke`. The client validates outbound and
inbound DTOs, retries only retrieval, and never retries generation. Question and message values
are not written to its error logs.

Remote failures never fall back to `free` automatically. A deliberate degradation updates the
same stack to `FaqPortsProfile=free` and clears all three remote parameters, after the operator has
verified that the local public KB is ready. Recovery is another reviewed deployment change that
restores the complete remote parameter set; approval, rollback evidence, and incident handling
belong in the deploying organization's runbook rather than this public transport contract.

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

## Opaque-session lifecycle (caller-visible behavior)

For a `remote-v1` caller the two-step flow behaves as:

1. `retrieve` returns only a short-lived opaque `sessionToken`; the KB projection stays server-side.
2. `generate` consumes that token once and returns the final public envelope. The request's
   `currentQuestion` must match the retrieval question bound to the token.
3. The same idempotency key with the same payload replays the in-flight/cached result; the same key
   with a different payload fails as `invalid_contract`.
4. Reusing a consumed token with another key fails as `expired_token`.

Each caller wait and provider call has a logical deadline, but physical cancellation still depends
on the low-level provider honoring its `timeoutMs`.

Server-side internals — the opaque-session composer, the session/replay/quota state store
(in-memory reference vs the managed DynamoDB state store), tenant namespacing, and the private
KB/prompt/LLM composition — live only in the canonical repository (`opaque-session.ts`,
`opaque-session-store.ts`, `production-rag.ts`, and the `lambda/stacks/remote-rag` stack) and are not
part of the public distribution.

Structured output is enabled only when both the selected model's server-owned allowlist decision
and the generation port capability permit it. The wire caller cannot choose the model or schema.

Public sync includes `http-client.ts` and its sanitized client test together with the higher-level
port, DTO validator, documentation, golden fixture, and wire-contract tests. It intentionally
excludes `opaque-session.ts`, `opaque-session-store.ts`, `production-rag.ts`, and the entire
`lambda/stacks/remote-rag` server implementation, including its KB search/injection, private prompt,
and LLM wiring.

The canonical handler and the public lite composition wire the public-safe HTTP client when
`FAQ_PORTS_PROFILE=remote`; the managed `remote-rag` stack owns and composes the excluded server
seam. The public lite SAM template requires the remote API base URL, the exact cross-account role
ARN, and its ExternalId together. It grants the generated FAQ caller role only `sts:AssumeRole` on
that configured role; the free profile does not initialize the remote client.
