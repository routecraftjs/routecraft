import { log, craft, simple, direct, noop } from "@routecraft/routecraft";
import { z } from "zod";

const OrderItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive(),
});

type OrderItem = z.infer<typeof OrderItemSchema>;

export interface PricedItem extends OrderItem {
  total: number;
  discounted: boolean;
}

const priceCheck = craft()
  .id("price-check")
  .title("Price check")
  .description("Validate one order item and apply pricing rules")
  .input({ body: OrderItemSchema })
  .from<OrderItem>(direct())
  .filter((ex) => {
    if (ex.body.quantity > 100) return { reason: "quantity exceeds limit" };
    return true;
  })
  .transform<PricedItem>((item) => {
    if (item.sku === "GADGET-B") throw new Error("GADGET-B recalled");
    const discount = item.quantity >= 10 ? 0.9 : 1;
    return {
      ...item,
      total: Math.round(item.unitPrice * item.quantity * discount * 100) / 100,
      discounted: discount < 1,
    };
  })
  .to(noop());

const processOrder = craft()
  .id("process-order")
  .from(
    simple({
      orderId: "ORD-2026-001",
      customer: "Acme Corp",
      items: [
        { sku: "WIDGET-A", name: "Widget A", quantity: 5, unitPrice: 12.99 },
        { sku: "GADGET-B", name: "Gadget B", quantity: 15, unitPrice: 8.5 },
        { sku: "GIZMO-C", name: "Gizmo C", quantity: 200, unitPrice: 3.0 },
        { sku: "THING-D", name: "Thing D", quantity: 1, unitPrice: 149.99 },
      ],
    }),
  )
  .tap(log())
  .transform((order) => order.items)
  .split()
  .schema(OrderItemSchema)
  .to(direct<OrderItem>("price-check"))
  .aggregate()
  .to(log());

export default [priceCheck, processOrder];
