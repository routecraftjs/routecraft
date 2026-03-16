import { log, craft, simple, http } from "@routecraft/routecraft";

export default craft()
  .id("split")
  .from(simple("1,2,3"))
  .transform((b) => b.split(",").map((i) => ({ userId: Number(i) })))
  .tap(log())
  .split()
  .filter((ex) => ex.body.userId !== 1)
  .transform((b) => {
    if (b.userId === 2) throw new Error("userId 2 is not allowed");
    return b;
  })
  .enrich(
    http<{ userId: number }, { name: string }>({
      method: "GET",
      url: (ex) =>
        `https://jsonplaceholder.typicode.com/users/${ex.body.userId}`,
    }),
  )
  .transform((result) => `Hello, ${result.body.name}!`)
  .aggregate()
  .to(log());
