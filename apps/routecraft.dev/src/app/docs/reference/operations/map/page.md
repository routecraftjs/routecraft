---
title: map
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
map<Return>(fieldMappings: Record<keyof Return, (src: Current) => Return[keyof Return]>): RouteBuilder<Return>
```

Map fields from the current data to create a new object of a specified type. Sugar for `.transform(mapper({...}))`: a specialized transformer that creates a new object by mapping fields from the source object.

```ts
// Map from API response to database model
.map<DbUser>({
  id: (apiUser) => apiUser.userId,
  name: (apiUser) => apiUser.fullName,
  email: (apiUser) => apiUser.emailAddress
})

// Transform with computed fields
.map<Summary>({
  fullName: (user) => `${user.firstName} ${user.lastName}`,
  isActive: (user) => user.status === 'active',
  displayEmail: (user) => user.email.toLowerCase()
})

// Map complex nested data
.map<OrderSummary>({
  orderId: (order) => order.id,
  customerName: (order) => order.customer.name,
  totalAmount: (order) => order.items.reduce((sum, item) => sum + item.price, 0),
  itemCount: (order) => order.items.length
})
```
