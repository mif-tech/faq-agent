# Remote FAQ RAG transports

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
inbound DTOs, retries only split retrieval, and never retries split generation or one-shot answer. Question and message values
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

`POST /v1/answer` is a separate `remote-one-shot-v1` contract defined in
`answer-contract.ts`. `createRemoteFaqRagAnswerHttpClient` implements `FaqRagAnswerPort`
using the same SigV4, AssumeRole credential cache, and endpoint configuration as the split client.
It sends one HTTP request and does not create or consume a retrieval session.

## Deployment transport selection

Both canonical and public-lite stacks expose `FaqRemoteRagTransport` with allowed values
`split-v1` and `one-shot-v1`, defaulting to `split-v1`. This becomes the Lambda environment
variable `FAQ_REMOTE_RAG_TRANSPORT`. The runtime reads it only for `FAQ_PORTS_PROFILE=remote`;
the missing value also defaults to `split-v1`, while empty, padded, or unknown values fail fast.
Settings and request headers do not select transports. Composition is a discriminated union:

```ts
type RemoteFaqTransport =
  | { kind: 'split-v1'; port: FaqRagPort }
  | { kind: 'one-shot-v1'; port: FaqRagAnswerPort };
```

One-shot HTTP retry count is always zero. A timeout, network error, 401/403, 429, 5xx, or
unsupported route produces a technical refusal; none invokes split or free as a fallback.
A contract-valid `no_match` 404 is a normal refusal. Every other 404/501 becomes the local
`remote_transport_unsupported` diagnosis, recorded by the shell's operator metric. This code
is not accepted in the server wire DTO. HTTP status must match the validated one-shot outcome.
Network, credential and non-contract gateway failures use `retrieval_failed` because the client
has no verified server phase; valid server error DTOs retain their specific failure code.
The one-shot caller's abort deadline covers credential lookup, AssumeRole, signing, HTTP and
response parsing. A timed-out caller stops waiting and never sends a late answer request.
The shared AssumeRole refresh may still complete for another caller or populate the warm cache;
late credential or signing failures are consumed without an unhandled rejection.

Rollback is a deployment change to `FaqRemoteRagTransport=split-v1` (and therefore
`FAQ_REMOTE_RAG_TRANSPORT=split-v1`). The public-lite caller role has only `sts:AssumeRole`
on the exact configured MIF invoker role. Exact `execute-api:Invoke` permission for
`/api/POST/v1/answer` belongs to that assumed role on the server side, alongside the existing
split routes. The canonical template retains its existing exact direct-invoke compatibility.
The default transport and server `answerEnabled` gate keep the new path inactive until rollout.

## One-shot contract

The request has exactly `contractVersion: "remote-one-shot-v1"`, `idempotencyKey`,
`currentQuestion`, `messages`, `remainingMs`, and optional `hints`. It carries no session token.
`messages` contains exactly one `user` message whose content ends with `currentQuestion`.
Question, message, key, deadline and hint bounds are identical to the split contract. Both hint
arrays are required when hints are present. Unknown fields and present-but-undefined values
are rejected at every JSON object boundary, including `tenantId`, `question`, provider settings
and telemetry. Tenant identity comes from the IAM principal's exact server role mapping.

Success is `{ contractVersion: "remote-one-shot-v1", ok: true, response }`, where `response`
uses the same public answer, source URL and refusal guards described below. Failure is
`{ contractVersion: "remote-one-shot-v1", ok: false, error: { code, retryable } }`, with
`retryAfterMs` required only for `quota_exceeded`.

| Error | HTTP status | Retryable |
| --- | --- | --- |
| `no_match` | 404 | false |
| `invalid_contract` | 400 | false |
| `quota_exceeded` | 429 | true |
| `kill_switch` | 503 | true |
| `deadline_exceeded` | 504 | true |
| `retrieval_failed` / `generation_failed` | 502 | true |

`expired_token` is invalid for one-shot. A 404 is `no_match` only when the body validates as
that one-shot error envelope; generic 404/501 responses are not contract outcomes. The server
does not select an older transport after any answer error. The same key and canonical payload
replays a terminal result, including retryable errors. `remainingMs` is excluded from payload
identity. In particular, a terminal `deadline_exceeded` result is replayed for the same key even
if a later request has a larger `remainingMs`. Its `retryable: true` permits a new workflow with
a new key; it does not authorize re-executing a terminal key. The HTTP client never retries,
rotates the supplied key, or falls back automatically. Reusing a key with a different question,
message, hints or contract version fails as `invalid_contract`; restarting an operation requires
a new key. In-flight duplicates wait only
within a bounded deadline, and an orphaned operation is never taken over for another provider call.

The server ships with the answer feature disabled for every existing tenant until its private
TenantConfig explicitly sets `answerEnabled: true`. Missing or false returns a valid one-shot
`kill_switch`. The existing global master control remains an emergency stop; no answer-specific
SSM request is added. The synthetic fixture `faq-chat-remote-one-shot-v1.golden.json` is public-safe;
provider-input and private core goldens remain under the denied server stack directory.

## Shell observability

Remote requests emit `remote_transport`, `remote_contract_version`, `remote_operation`,
`remote_http_calls`, `remote_ms`, and `remote_error_code` for failures. The invocation-local
HTTP observer counts actual fetch attempts, including split retrieval retries and zero when
validation or credentials stop a request before fetch. `remote_ms` includes credential resolution,
signing, HTTP and response validation; `router_ms` covers local shell routing only. The shell
continues to measure `settings_ms` and `total_ms` separately.

Both clients stop waiting for credentials, signing, fetch and body parsing at the caller
deadline. Shared credential refresh may settle afterward; it cannot start a late HTTP call
for the expired request. A cold credential/AssumeRole cache miss is part of `remote_ms`.
The trusted client option `retrieveMaxRetries: 0` allows a controlled evaluation composition
to disable split retries. The default remains two retries, with no environment or request
header override in production composition.

The shell response header `x-faq-request-id` matches its metric `requestId`; `coldStart`
describes the shell invocation. `remote_requests` records bounded operation, HTTP status,
and available remote request IDs from response headers. Join **every** remote call to its
server terminal record when classifying warmth; a split arm can have two remote invocations.
Missing IDs or cold-start evidence do not prove a warm request. These are diagnostic log
fields, not metric dimensions or wire-body fields. Runner HTTP elapsed time through full
body receipt remains the end-to-end latency; the earlier shell `total_ms` sample is separate.

### Terminal shell timing fields

Canonical and public shells use the same invocation-local recorder. Existing `faq_chat`
metrics retain their fields and are emitted at the original response decision point,
before Q&A work. A separate `faq_shell_timing` terminal event is emitted in `finally`
after awaited Q&A work and response serialization, including paths without `faq_chat`
(such as preflight or rejected input). Correlate the two events by `requestId`; a Lambda
hard timeout can prevent the terminal event without losing an already emitted `faq_chat`.
For that cohort, supplement missing `faq_shell_timing` events with CloudWatch `Duration`
and `Task timed out` logs.
Use exact JSON metric filters such as `{ $.metric = "faq_chat" }`, not substring matches
or a sum of the two event counts. No timing field is added to response DTOs.

| Fields | Meaning |
| --- | --- |
| `handler_total_ms`, `handler_outcome` | Handler entry through the terminal snapshot, including awaited Q&A and response serialization; excludes Lambda INIT, final metric serialization/log delivery, Gateway and browser transit. Outcome is `success` for a completed HTTP response below 400, `skipped` for preflight/4xx, `disabled` for the Settings kill switch, or `failure` for 5xx/unhandled exceptions; it does not measure answer quality. |
| `remaining_start_ms`, `remaining_return_ms` | Lambda remaining time at entry and the terminal snapshot; null when no valid Lambda context is available. |
| `qa_write_ms`, `qa_write_outcome`, `qa_notify_ms`, `qa_notify_outcome` | Caller time waiting for Q&A Put and the optional synchronous notification. A timeout records only the bounded wait, not a later background completion. Async public delivery records `skipped` for shell notification; worker delivery is observed separately. |
| `settings_ms`, `router_ms`, `smalltalk_settle_ms`, `response_serialize_ms` | Settings I/O, local router, waiting for the remaining smalltalk pipeline, and serializing the HTTP response. These intervals can overlap other existing diagnostic intervals; do not blindly sum every field. |
| `credential_wait_ms`, `assume_role_ms`, `assume_role_attempts` | Sum of observed credential waits, observed STS work and SDK attempts, also retained in bounded `credential_events`. AssumeRole time includes the SDK's source credential/signing/retry work from refresh start until completion or caller cutoff. Multiple waiters may observe the same shared refresh; their times/counts are not additive distinct STS work. Timed-out callers do not emit a second update when a shared refresh later settles. |
| `credential_cache`, `credential_outcome`, `credential_events` | Last credential observation and its ordered events. `cold` means no shell role cache, `refresh` means renewal or joining renewal, `hit` means no shell STS refresh; the direct SDK provider's own cache is opaque. `skipped` means no credential step. A failed refresh can report failure while a still-valid cached credential lets the request succeed. |
| `remote_attempts` | Bounded ordered objects with `operation` (`retrieve`, `generate`, `answer`), one-based `attempt`, `signing_ms`, `http_headers_ms`, `body_parse_ms`, `retry_wait_ms`, and `outcome`. HTTP wait ends when fetch returns headers; body timing covers body read and parse. Retry wait belongs to the preceding attempt. Credential waits are recorded separately. |
| `retrieve_attempts`, `generate_attempts`, `answer_attempts` | Recorded client attempts per operation, including a credential/signing failure before fetch. Use existing `remote_http_calls` for actual HTTP requests. One-shot does not retry. |
| `remaining_at_generate_start_ms`, `effective_generate_timeout_ms`, `generate_end_reason` | Shell generation budget after the response reserve (null without Lambda context), effective caller operation timeout, and finite terminal classification. Local calls retain their configured cap, including the default 20,000 ms without context; split includes credential/signing/HTTP work and the client's abort margin. One-shot generation budgets stay null because the shell cannot observe provider start. `generate_end_reason` reflects the returned remote outcome or local validation result; a swallowed provider error is `failure`, not an inferred timeout. Unattempted generation is `skipped`. |
| `remaining_at_answer_start_ms`, `effective_answer_timeout_ms` | One-shot caller budget and timer after its abort margin, covering the whole answer operation including retrieval. Null for other routes. These are not private provider generation caps. |

STS attempt counting uses an absolute `finalizeRequest` / `low` middleware registration.
The SDK retry middleware runs at `finalizeRequest` / `high`, so each retry reaches the
counter without a dependency on the retry middleware's name at stack resolution.
`assume_role_attempts` counts STS HTTP attempts, including retries; credential or signing
failures before an HTTP attempt are not counted. This differs from the client operation
counts `retrieve_attempts`, `generate_attempts`, and `answer_attempts` described above.
Counting as attempts start also preserves caller-cutoff snapshots while STS is still
in flight; response `$metadata.attempts` would only be available after completion.
If metric registration itself fails, AssumeRole continues with the counter at zero.

Duration fields are nonnegative milliseconds. Side-effect/attempt outcomes are only
`success`, `disabled`, `skipped`, `timeout`, or `failure`; generation additionally permits
`no_match`, `truncated`, `refused`, and `invalid_response`. Untouched intervals are zero,
not proof of a successful call. The recorder projects fixed fields and enums, never error
messages, request/response bodies, contact values, URLs, headers or credentials. Late work
cannot alter a finished invocation or the next invocation's event.

The terminal event contains shell timing fields and correlation fields only; it does not
copy or overwrite `faq_chat` fields such as `total_ms`, `settings_ms`, or `router_ms`.
Join its `requestId` to `faq_chat`, then use that event's `remote_requests`,
`remote_transport`, and shell `coldStart` to join MIF metrics. Remote cold state comes from joined MIF records, not a shell
guess. Separate cold/warm, STS hit/refresh/cold and retrieval-retry cohorts. HTTP header wait
minus MIF latency still includes Gateway and initialization effects and is not pure network
time. Measure full client HTTP latency separately; changing instrumentation or enabling
async notifications does not raise any existing generation timeout.

One-shot failure logs retain finite HTTP status even for a valid technical error DTO. A
401/403 can therefore be diagnosed independently of the public `retrieval_failed` code.
Positive rollout smoke returning 403 fails authorization validation; only an intentional
negative-role test should expect it. Unsupported transport classification remains limited
to non-contract 404/501 and never authorizes a fallback.

One-shot does not assign server retrieval or generation time to shell `kb_retrieval_ms` or
`model_ms`. Remote token usage is omitted, with `token_usage_source: "remote_unavailable"`;
zero would imply a measurement that the public wire contract does not supply. **This token-field
change applies to the split-v1 transport as well** — remote responses never carried real token
counts, so the previous `input_tokens: 0` / `output_tokens: 0` placeholders are now omitted on
both transports. Update any Logs Insights queries or metric filters that referenced those
fields on `faq_chat` metrics. `token_usage_source: "remote_unavailable"` means the **generation**
tokens are unknown because generation happens remotely; local smalltalk/router token fields
(for example `smalltalk_input_tokens`) may still be present in the same metric line. Server-side
retrieval, model timing and tokens remain in the private server metrics. Questions, KB content,
idempotency keys and raw provider output are never transport metric or error-log fields.

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

Public sync includes `http-client.ts` and its sanitized split/answer client tests together with
the higher-level ports, transport selector, DTO validators, documentation, synthetic golden
fixtures, and wire-contract tests. Each file is explicitly allowlisted. It intentionally
excludes `opaque-session.ts`, `opaque-session-store.ts`, `production-rag.ts`, and the entire
`lambda/stacks/remote-rag` server implementation, including its KB search/injection, private prompt,
and LLM wiring.

The canonical handler and the public lite composition wire the public-safe HTTP client when
`FAQ_PORTS_PROFILE=remote`; the managed `remote-rag` stack owns and composes the excluded server
seam. The public lite SAM template requires the remote API base URL, the exact cross-account role
ARN, and its ExternalId together. It grants the generated FAQ caller role only `sts:AssumeRole` on
that configured role; the free profile does not initialize the remote client.
