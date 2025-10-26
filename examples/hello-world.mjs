import { log, craft, simple, fetch } from "@routecraft/routecraft";

export default craft()
  .id("hello-world")
  .from(simple({ userId: 1 }))
  .enrich(
    fetch({
      method: "GET",
      url: (ex) =>
        `https://jsonplaceholder.typicode.com/users/${ex.body.userId}`,
    }),
  )
  .transform((res) => JSON.parse(res.body))
  .transform((user) => `Hello, ${user.name}!`)
  .to(log());
