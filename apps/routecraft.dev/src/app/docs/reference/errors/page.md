---
title: Errors
---

Error policy, codes, and docsUrl contract. {% .lead %}

Codes live in `packages/routecraft/src/error.ts` as `ErrorCode`.

docsUrl contract: every thrown `RouteCraftError` should include a `docs` URL pointing to an anchor explaining the fix.

## Route errors

### RC-INVALID-ROUTE-DEFINITION {#rc-invalid-route-definition}

Thrown when a route has no source. Ensure `.from(...)` is called.

### RC-DUPLICATE-ROUTE-DEFINITION {#rc-duplicate-route-definition}

Thrown when route ids conflict. Ensure ids are unique.

### RC-MISSING-FROM-DEFINITION {#rc-missing-from-definition}

Thrown when steps are added before `.from(...)`.

## Adapter/operation errors

### RC-SOURCE-ERROR {#rc-source-error}

Thrown by sources during `subscribe`.

### RC-PROCESSING-ERROR {#rc-processing-error}

Thrown by processors.

### RC-DESTINATION-ERROR {#rc-destination-error}

Thrown by destinations.

### RC-SPLITTING-ERROR {#rc-splitting-error}

Thrown by split operations.

### RC-AGGREGATION-ERROR {#rc-aggregation-error}

Thrown by aggregate operations.

### RC-TRANSFORMING-ERROR {#rc-transforming-error}

Thrown by transform operations.

### RC-TAPPING-ERROR {#rc-tapping-error}

Thrown by tap operations.

### RC-FILTER-ERROR {#rc-filter-error}

Thrown by filter operations.

### RC-VALIDATE-ERROR {#rc-validate-error}

Thrown by validate operations.

## Runtime/config errors

### RC-ROUTE-COULD-NOT-START {#rc-route-could-not-start}

Thrown when a route fails to start. Inspect logs for the specific cause.

### RC-CONTEXT-COULD-NOT-START {#rc-context-could-not-start}

Thrown when the context fails to start.

### RC-UNKNOWN-ERROR {#rc-unknown-error}

Fallback error code.

{% callout type="warning" title="TODO: Align codes" %}
Map `ErrorCode` enum values to canonical RC codes and ensure every throw site includes `.docs` that targets an anchor on these pages.
{% /callout %}
