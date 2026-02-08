---
title: Errors
---

Short, actionable RC error codes used across RouteCraft. {% .lead %}

Each error includes a code, message, a brief suggestion, and underlying error. Codes follow RCcnnn where c is category and nnn is the number.

## Retryable errors

The `retryable` property indicates whether the [`retry`](/docs/reference/operations#retry) wrapper will retry this error by default. Errors marked as non-retryable typically represent permanent failures (bad input, configuration errors) that won't succeed on retry.

| Code | Category | Message | Retryable |
| --- | --- | --- | :---: |
| [RC1001](#rc-1001) | Definition | Route definition failed validation | No |
| [RC1002](#rc-1002) | Definition | Duplicate route id | No |
| [RC2001](#rc-2001) | DSL | Invalid operation type | No |
| [RC2002](#rc-2002) | DSL | Missing from step | No |
| [RC3001](#rc-3001) | Lifecycle | Route failed to start | No |
| [RC3002](#rc-3002) | Lifecycle | Context failed to start | No |
| [RC5001](#rc-5001) | Adapter | Source adapter threw | Yes |
| [RC5002](#rc-5002) | Adapter | Processing step threw | Yes |
| [RC5003](#rc-5003) | Adapter | Destination adapter threw | Yes |
| [RC5004](#rc-5004) | Adapter | Split operation failed | No |
| [RC5005](#rc-5005) | Adapter | Aggregation operation failed | No |
| [RC5006](#rc-5006) | Adapter | Transform function threw | No |
| [RC5007](#rc-5007) | Adapter | Tap step threw | Yes |
| [RC5008](#rc-5008) | Adapter | Filter predicate threw | No |
| [RC5009](#rc-5009) | Adapter | Validation failed | No |
| [RC5010](#rc-5010) | Adapter | Dynamic endpoints cannot be used as source | No |
| [RC5011](#rc-5011) | Adapter | Direct route schema validation failed | No |
| [RC9901](#rc-9901) | Runtime | Unknown error | Yes |

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
const ctx = context().routes(myRoute).build();
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
context().routes(validRoutes).build().start()
```

## RC5001
Source adapter threw

**Why it happens**  
Source failed during subscription or production.

**Suggestion**  
Verify connectivity and adapter options.

## RC5002
Processing step threw

**Why it happens**  
Processor logic threw or rejected.

**Suggestion**  
Add guards to transforms and processors.

## RC5003
Destination adapter threw

**Why it happens**  
Destination failed to send data.

**Suggestion**  
Verify destination connectivity and options.

## RC5004
Split operation failed

**Why it happens**  
Split function threw or input was not iterable.

**Suggestion**  
Ensure the input is iterable and guarded.

## RC5005
Aggregation operation failed

**Why it happens**  
Aggregation logic threw or shapes mismatched.

**Suggestion**  
Validate partial shapes and defaults.

## RC5006
Transform function threw

**Why it happens**  
Transform logic threw or accessed missing properties.

**Suggestion**  
Narrow input types and add guards.

## RC5007
Tap step threw

**Why it happens**  
Side-effect function threw.

**Suggestion**  
Keep tap side effects resilient.

## RC5008
Filter predicate threw

**Why it happens**  
Predicate accessed missing fields or threw.

**Suggestion**  
Guard against missing properties and unexpected shapes.

## RC5009
Validation failed

**Why it happens**  
Schema failed or validator threw.

**Suggestion**  
Adjust the schema or coerce input.

## RC5010
Dynamic endpoints cannot be used as source

**Why it happens**  
A direct adapter with a function endpoint was used with `.from()`. Dynamic endpoints require an exchange to evaluate, but sources don't have incoming exchanges.

**Suggestion**  
Use a static string endpoint for source: `.from(direct('endpoint', {}))`. Dynamic endpoints only work with `.to()` and `.tap()`.

**Example**
```ts
// ✅ Correct: static endpoint for source
craft()
  .from(direct('my-endpoint', {}))
  .to(destination)

// ✅ Correct: dynamic endpoint for destination
craft()
  .from(source)
  .to(direct((ex) => `endpoint-${ex.body.type}`))

// ❌ Wrong: dynamic endpoint for source
craft()
  .from(direct((ex) => 'endpoint')) // throws RC5010
```

## RC5011
Direct route schema validation failed

**Why it happens**  
Message body or headers don't match the schema defined in direct adapter options.

**Suggestion**  
Check message structure matches schema. For Zod 4: use `z.object()` (strips extras), `z.looseObject()` (keeps extras), or `z.strictObject()` (rejects extras).

**Example**
```ts
import { z } from 'zod'

// z.object() - strips extra fields (default)
craft()
  .from(direct('endpoint', {
    schema: z.object({ id: z.string() })
  }))
  .to(handler)
// Pass: { id: '123' }
// Pass: { id: '123', extra: 'field' } (extra removed)

// z.strictObject() - rejects extra fields
craft()
  .from(direct('endpoint', {
    schema: z.strictObject({ id: z.string() })
  }))
  .to(handler)
// Pass: { id: '123' }
// Fail: { id: '123', extra: 'field' } ← RC5011

// z.looseObject() - keeps extra fields
craft()
  .from(direct('endpoint', {
    schema: z.looseObject({ id: z.string() })
  }))
  .to(handler)
// Pass: { id: '123', extra: 'field' } (extra preserved)
```

## RC9901
Unknown error

**Why it happens**  
Unexpected failure without a specific code.

**Suggestion**  
Check logs and enable debug level.
