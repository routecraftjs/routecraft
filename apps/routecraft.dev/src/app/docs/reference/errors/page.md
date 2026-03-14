---
title: Errors
---

Short, actionable RC error codes used across Routecraft. {% .lead %}

Each error includes a code, message, a brief suggestion, and underlying error. Codes follow RCcnnn where c is category and nnn is the number. All codes are framework-owned; adapters use them with specific message/suggestion overrides via `rcError(rc, cause, { message, suggestion })`. When the framework logs an error, structured meta (`rc`, `message`, `suggestion`, `causeMessage`, `causeStack`) is included so you can search and alert in your log aggregator.

## Retryable errors

The `retryable` property indicates whether the [`retry`](/docs/reference/operations#retry) wrapper will retry this error by default. Errors marked as non-retryable typically represent permanent failures (bad input, configuration errors) that won't succeed on retry.

| Code | Category | Message | Retryable |
| --- | --- | --- | :---: |
| [RC1001](#rc1001) | Definition | Route definition failed validation | No |
| [RC1002](#rc1002) | Definition | Duplicate route id | No |
| [RC2001](#rc2001) | DSL | Invalid operation type | No |
| [RC2002](#rc2002) | DSL | Missing from step | No |
| [RC3001](#rc3001) | Lifecycle | Route failed to start | No |
| [RC3002](#rc3002) | Lifecycle | Context failed to start | No |
| [RC5001](#rc5001) | Adapter | Step execution failed | Yes |
| [RC5002](#rc5002) | Adapter | Validation failed | No |
| [RC5003](#rc5003) | Adapter | Adapter misconfigured | No |
| [RC5004](#rc5004) | Adapter | No handler available | No |
| [RC5010](#rc5010) | Adapter | Connection failed | Yes |
| [RC5011](#rc5011) | Adapter | Request timeout | Yes |
| [RC5012](#rc5012) | Adapter | Authentication failed | No |
| [RC5013](#rc5013) | Adapter | Rate limited | Yes |
| [RC5014](#rc5014) | Adapter | Resource not found | No |
| [RC5015](#rc5015) | Adapter | Permission denied | No |
| [RC9901](#rc9901) | Runtime | Unknown error | Yes |

---

## RC1001
Route definition failed validation

**Why it happens**  
The route is missing required fields, most commonly a source.

**Suggestion**  
Ensure a source is defined: start with `from(adapter)` and then add steps.

**Example**
```ts
craft().id('my-route').from(timer())
```

## RC1002
Duplicate route id

**Why it happens**  
Two or more routes share the same id.

**Suggestion**  
Ensure each route id is unique or set `routeOptions.id`.

**Example**
```ts
craft().from(timer()).id('users');
craft().from(timer()).id('orders');
```

## RC2001
Invalid operation type

**Why it happens**  
The step received unsupported input.

**Suggestion**  
Use a supported operator and verify the step name.

**Example**
```ts
// split requires an array
craft().from(simple(['a','b'])).split()
```

## RC2002
Missing from step

**Why it happens**  
Steps were added before defining a source.

**Suggestion**  
Start the route with `from` and a valid source adapter.

**Example**
```ts
craft().from(timer()).transform(x => x)
```

## RC3001
Route failed to start

**Why it happens**  
The route's abort controller was already aborted or an adapter could not initialize.

**Suggestion**  
Ensure the route isn't aborted before `start()`. Verify adapter configuration.

**Example**
```ts
const ctx = await new ContextBuilder().routes(myRoute).build();
await ctx.start();
```

## RC3002
Context failed to start

**Why it happens**  
Invalid configuration, duplicate ids, or missing sources.

**Suggestion**  
Validate plugin exports and global configuration.

**Example**
```ts
const ctx = await new ContextBuilder().routes(validRoutes).build()
await ctx.start()
```

## RC5001
Step execution failed

**Why it happens**  
A step in the pipeline threw (process, transform, filter, tap, destination, etc.). The framework wraps plain Errors with this code and preserves the original message.

**Suggestion**  
Read the error message and suggestion in the log; check adapter documentation. Use `rcError("RC5010", cause, { message, suggestion })` for connection failures, RC5013 for rate limits, etc., so users get a specific docs page.

## RC5002
Validation failed

**Why it happens**  
Schema validation failed, input shape was wrong, or a validator threw (e.g. direct route body/header schema, validate() step, aggregator received empty array).

**Suggestion**  
Adjust the schema or coerce input; check data shapes. For Zod: use `z.object()`, `z.looseObject()`, or `z.strictObject()` as appropriate.

## RC5003
Adapter misconfigured

**Why it happens**  
Adapter was used in the wrong role (e.g. dynamic endpoint as source), required options are missing, or the adapter does not support this usage.

**Suggestion**  
Check required options and correct role usage (`.from()` vs `.to()`). Example: use a static string endpoint for source: `.from(direct('endpoint', {}))`; dynamic endpoints only work with `.to()` and `.tap()`.

## RC5004
No handler available

**Why it happens**  
A producer sent to a direct endpoint but no consumer route is subscribed, or the consumer route has stopped.

**Suggestion**  
Ensure the consumer route is running before sending. Check route startup order and that endpoint names match.

**Example**
```ts
craft().id('consumer').from(direct('my-endpoint', {})).to(log());
craft().id('producer').from(simple('message')).to(direct('my-endpoint'));
```

## RC5010
Connection failed

**Why it happens**  
Network unreachable, connection refused, DNS failure, or service not running.

**Suggestion**  
Check network, DNS, ports, and firewall; verify the service is running.

## RC5011
Request timeout

**Why it happens**  
The operation exceeded its deadline (e.g. ETIMEDOUT).

**Suggestion**  
Increase timeout or configure retry with backoff.

## RC5012
Authentication failed

**Why it happens**  
Invalid credentials, expired token, or 401 from the service.

**Suggestion**  
Verify API keys, tokens, and credential configuration.

## RC5013
Rate limited

**Why it happens**  
Service returned 429 or quota exceeded.

**Suggestion**  
Reduce request frequency or configure retry with backoff.

## RC5014
Resource not found

**Why it happens**  
The resource does not exist (e.g. 404, model ID not found, endpoint or queue name wrong).

**Suggestion**  
Check that the resource exists (model ID, endpoint, queue name).

## RC5015
Permission denied

**Why it happens**  
Access control or IAM denied the operation (e.g. 403).

**Suggestion**  
Check access control, IAM, and scopes.

## RC9901
Unknown error

**Why it happens**  
Unexpected failure without a specific code.

**Suggestion**  
Check logs and enable debug level.
