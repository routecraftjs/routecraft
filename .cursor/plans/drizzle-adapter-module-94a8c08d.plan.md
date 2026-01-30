<!-- 94a8c08d-2ceb-439d-b97d-7039b70e2598 9893b85e-e5d7-4015-aaa0-37e92d39072e -->
# Drizzle Adapter Module

## Overview

Create a unified Drizzle adapter that integrates Drizzle ORM with RouteCraft routes, supporting:

- **Destination (to):** Insert, update, and upsert operations
- **Source (from):** Query operations with filtering and pagination
- **Enricher (enrich):** Exchange-driven query operations (same as Source but per-exchange)

The adapter uses TypeScript overloads and context-aware options to provide type-safe, operation-specific configurations.

## Design Decisions

### Store Key Pattern

- Default store key: `"routecraft.adapter.drizzle.db"` for the main database instance
- Named databases use suffix pattern: `"routecraft.adapter.drizzle.db.{name}"`
  - Example: `"routecraft.adapter.drizzle.db.analytics"`, `"routecraft.adapter.drizzle.db.warehouse"`
- When using `storeKey: 'analytics'`, adapter looks up `"routecraft.adapter.drizzle.db.analytics"`

### API Design - Three Operation Modes

#### 1. Destination (Write Operations)

```typescript
// Basic upsert using default db
.to(drizzle({ 
  table: employees, 
  values: (ex) => ex.body 
}))

// Use named database
.to(drizzle({ 
  storeKey: 'analytics',
  table: events,
  values: (ex) => ex.body
}))

// Insert mode (fail on conflict)
.to(drizzle({ 
  table: employees,
  values: (ex) => ex.body,
  mode: 'insert'
}))

// Update existing records only
.to(drizzle({ 
  table: employees,
  values: (ex) => ex.body,
  mode: 'update',
  where: (table, ex) => eq(table.id, ex.body.id)
}))

// Upsert with custom conflict target
.to(drizzle({ 
  table: employees,
  values: (ex) => ex.body,
  mode: 'upsert',
  conflictTarget: employees.email
}))

// Partial field updates on conflict
.to(drizzle({ 
  table: employees,
  values: (ex) => ex.body,
  mode: 'upsert',
  fields: ['name', 'email', 'updated_at']
}))
```

#### 2. Source (Read Operations)

```typescript
// Basic query - all records
.from(drizzle({
  table: employees
}))

// With filtering
.from(drizzle({
  table: employees,
  where: (table) => eq(table.status, 'active')
}))

// With pagination and ordering
.from(drizzle({
  table: employees,
  where: (table) => eq(table.department, 'Engineering'),
  limit: 100,
  offset: 0,
  orderBy: (table) => desc(table.created_at)
}))

// Select specific fields
.from(drizzle({
  table: employees,
  select: ['id', 'name', 'email'],
  where: (table) => eq(table.status, 'active')
}))
```

#### 3. Enricher (Exchange-Driven Queries)

Enricher uses the **same query options as Source**, but the `where` clause has access to the exchange:

```typescript
// Basic lookup - enrich with employee data based on exchange
.enrich(drizzle({
  table: employees,
  where: (table, ex) => eq(table.id, ex.body.employee_id)
}))

// Lookup with specific fields
.enrich(drizzle({
  table: employees,
  where: (table, ex) => eq(table.id, ex.body.employee_id),
  select: ['name', 'email', 'department']
}))

// Multiple results with limit
.enrich(drizzle({
  table: orders,
  where: (table, ex) => eq(table.customer_id, ex.body.customerId),
  limit: 10,
  orderBy: (table) => desc(table.created_at)
}))

// Complex where clause
.enrich(drizzle({
  table: employees,
  where: (table, ex) => and(
    eq(table.department, ex.body.department),
    eq(table.status, 'active')
  ),
  limit: 5
}))

// Custom aggregation of enriched data
.enrich(
  drizzle({
    table: employees,
    where: (table, ex) => eq(table.id, ex.body.employee_id),
    select: ['name', 'email']
  }),
  (original, enriched) => ({
    ...original,
    body: {
      ...original.body,
      employeeName: enriched?.name,
      employeeEmail: enriched?.email
    }
  })
)
```

**Key insight:** The only difference between Source and Enricher is that Enricher's `where` function receives the exchange as a second parameter, allowing dynamic queries based on the flowing data.

## Implementation Plan

### 1. Create Drizzle Adapter File

**File:** `packages/routecraft/src/adapters/drizzle.ts`

**Type definitions:**

```typescript
// Common options
interface DrizzleBaseOptions {
  db?: any; // Drizzle database instance (optional, falls back to context store)
  storeKey?: string; // Custom store key suffix (e.g., 'analytics')
  table: any; // Drizzle table schema
}

// Write operations (Destination)
export interface DrizzleWriteOptions<TTable, TBody> extends DrizzleBaseOptions {
  table: TTable;
  values: ((exchange: Exchange<TBody>) => any | any[]) | any | any[];
  mode?: 'insert' | 'update' | 'upsert'; // Default: 'upsert'
  conflictTarget?: any; // For upsert mode (default: auto-detect primary key)
  fields?: string[] | any[]; // Fields to update (default: all fields from values)
  where?: (table: TTable, exchange: Exchange<TBody>) => any; // For update mode
}

// Read operations (Source)
export interface DrizzleReadOptions<TTable> extends DrizzleBaseOptions {
  table: TTable;
  where?: (table: TTable) => any; // Drizzle where clause
  select?: string[]; // Specific fields to select
  limit?: number;
  offset?: number;
  orderBy?: (table: TTable) => any;
}

// Lookup operations (Enricher) - same as read but where clause gets exchange
export interface DrizzleEnrichOptions<TTable, TBody> extends DrizzleBaseOptions {
  table: TTable;
  where: (table: TTable, exchange: Exchange<TBody>) => any; // Exchange-driven where
  select?: string[]; // Specific fields to select
  limit?: number; // Limit results (useful for one-to-many lookups)
  offset?: number;
  orderBy?: (table: TTable) => any;
}

// Union type for all options
export type DrizzleOptions<TTable, TBody> = 
  | DrizzleWriteOptions<TTable, TBody>
  | DrizzleReadOptions<TTable>
  | DrizzleEnrichOptions<TTable, TBody>;
```

**Class implementation:**

```typescript
export class DrizzleAdapter<TTable = any, TBody = unknown>
  implements Source<TBody>, Enricher<TBody, any>, Destination<TBody> {
  
  readonly adapterId = "routecraft.adapter.drizzle";
  
  constructor(private options: DrizzleOptions<TTable, TBody>) {}
  
  // Destination implementation
  async send(exchange: Exchange<TBody>): Promise<void> {
    const opts = this.options as DrizzleWriteOptions<TTable, TBody>;
    const db = this.getDatabase(exchange);
    // Write logic: insert, update, or upsert
  }
  
  // Source implementation
  async subscribe(
    context: CraftContext,
    handler: (message: TBody, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController
  ): Promise<void> {
    const opts = this.options as DrizzleReadOptions<TTable>;
    const db = this.getDatabaseFromContext(context);
    // Query logic: select with filters
    // Returns single exchange with results (could be array)
  }
  
  // Enricher implementation
  async enrich(exchange: Exchange<TBody>): Promise<any> {
    const opts = this.options as DrizzleEnrichOptions<TTable, TBody>;
    const db = this.getDatabase(exchange);
    // Query logic: same as source but using exchange in where clause
    // If limit=1 or single result, return object; otherwise return array
  }
  
  private getDatabase(exchange: Exchange<TBody>): any {
    // Priority: direct db > store with key > default store
  }
  
  private getDatabaseFromContext(context: CraftContext): any {
    // For source operations without exchange
  }
}
```

### 2. Extend StoreRegistry

```typescript
declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    "routecraft.adapter.drizzle.db": any; // Default drizzle db
    [key: `routecraft.adapter.drizzle.db.${string}`]: any; // Named drizzle dbs
  }
}
```

### 3. Add DSL Helper Function

**File:** `packages/routecraft/src/dsl.ts`

```typescript
export function drizzle<TTable = any, TBody = unknown>(
  options: DrizzleOptions<TTable, TBody>
): DrizzleAdapter<TTable, TBody> {
  return new DrizzleAdapter<TTable, TBody>(options);
}
```

### 4. Export from Index

**File:** `packages/routecraft/src/index.ts`

```typescript
export { 
  DrizzleAdapter, 
  type DrizzleOptions,
  type DrizzleWriteOptions,
  type DrizzleReadOptions,
  type DrizzleEnrichOptions
} from "./adapters/drizzle.ts";
```

Update DSL exports to include `drizzle`.

### 5. Phase 1: Implement Destination (Write) Only

For the initial implementation, focus on the `Destination` interface:

- Implement `send()` method
- Support insert, update, and upsert modes
- Auto-detect batch vs single record
- Auto-detect primary keys
- Field filtering for partial updates

**Leave `subscribe()` and `enrich()` as stubs that throw "Not yet implemented" errors.**

### 6. Context Configuration Examples

**Single database:**

```typescript
const ctx = context()
  .store("routecraft.adapter.drizzle.db", db)
  .routes(ingestEmployeesRoute, ingestPayrunsRoute)
  .build();
```

**Multiple databases:**

```typescript
const ctx = context()
  .store("routecraft.adapter.drizzle.db", mainDb)
  .store("routecraft.adapter.drizzle.db.analytics", analyticsDb)
  .store("routecraft.adapter.drizzle.db.warehouse", warehouseDb)
  .routes(...)
  .build();

// Use in routes with storeKey (just the suffix)
craft()
  .from(timer({ intervalMs: 60000 }))
  .to(drizzle({ 
    storeKey: 'analytics',
    table: events, 
    values: (ex) => ex.body 
  }))
```

### 7. Refactor Example Route

Update `routes/ingest-employees.ts` to use the new adapter:

**Before:**

```typescript
.aggregate((exchanges) => ({
  ...exchanges[0],
  body: exchanges.map((x) => x.body),
}))
.to(async ({ body }) => {
  await db.insert(employees).values(body).onConflictDoUpdate({
    target: employees.id,
    set: {
      first_name: sql.raw(`excluded.${employees.first_name.name}`),
      surname: sql.raw(`excluded.${employees.surname.name}`),
      // ... 12 more fields manually mapped
    }
  });
})
```

**After:**

```typescript
.aggregate((exchanges) => ({
  ...exchanges[0],
  body: exchanges.map((x) => x.body),
}))
.to(drizzle({ 
  table: employees, 
  values: (ex) => ex.body 
}))
```

## Implementation Details

### Database Resolution Priority

1. Direct `db` option (if provided)
2. Store with custom key: `"routecraft.adapter.drizzle.db.{storeKey}"` (if storeKey provided)
3. Default store: `"routecraft.adapter.drizzle.db"`
4. Throw error if no database found

### Primary Key Auto-Detection

```typescript
private getPrimaryKeys(table: any): any[] {
  return Object.values(table)
    .filter((col: any) => col?.primary === true);
}
```

### Field Mapping for Upsert

```typescript
private buildUpdateFields(table: any, values: any, fields?: string[]): Record<string, any> {
  const fieldsToUpdate = fields || Object.keys(values[0] || values);
  const primaryKeyNames = this.getPrimaryKeys(table).map(col => col.name);
  
  return fieldsToUpdate
    .filter(field => !primaryKeyNames.includes(field))
    .reduce((acc, field) => ({
      ...acc,
      [field]: sql.raw(`excluded.${table[field]?.name || field}`)
    }), {});
}
```

### Batch vs Single Detection

```typescript
private resolveValues(exchange: Exchange<TBody>, opts: DrizzleWriteOptions<TTable, TBody>): any[] {
  const resolved = typeof opts.values === 'function' 
    ? opts.values(exchange) 
    : opts.values;
  return Array.isArray(resolved) ? resolved : [resolved];
}
```

### Shared Query Building (Source & Enricher)

Both Source and Enricher use the same query builder logic:

```typescript
private buildQuery(db: any, table: any, options: DrizzleReadOptions | DrizzleEnrichOptions, exchange?: Exchange) {
  let query = db.select().from(table);
  
  if (options.where) {
    const whereClause = exchange 
      ? options.where(table, exchange)  // Enricher: pass exchange
      : options.where(table);            // Source: no exchange
    query = query.where(whereClause);
  }
  
  if (options.select) {
    // Apply select fields
  }
  
  if (options.orderBy) {
    query = query.orderBy(options.orderBy(table));
  }
  
  if (options.limit) {
    query = query.limit(options.limit);
  }
  
  if (options.offset) {
    query = query.offset(options.offset);
  }
  
  return query;
}
```

## Phase 1 Scope (This Plan)

- ✅ Destination (write operations): insert, update, upsert
- ✅ Auto-detect batch vs single
- ✅ Primary key auto-detection
- ✅ Field filtering
- ✅ Multiple database support via store
- ❌ Source (read operations) - stub only
- ❌ Enricher (lookup operations) - stub only

## Future Enhancements (Phase 2+)

- Implement Source for SELECT queries with streaming
- Implement Enricher for JOIN/lookup operations
- Transaction support across operations
- Custom SQL query support
- Drizzle query builder passthrough

### To-dos

- [ ] Create DrizzleAdapter class in packages/routecraft/src/adapters/drizzle.ts with full Destination implementation and stubs for Source/Enricher
- [ ] Add drizzle() helper function to packages/routecraft/src/dsl.ts
- [ ] Update packages/routecraft/src/index.ts to export DrizzleAdapter types and drizzle DSL function
- [ ] Refactor routes/ingest-employees.ts to use the new Drizzle adapter
- [ ] Update example to show context configuration with db in store