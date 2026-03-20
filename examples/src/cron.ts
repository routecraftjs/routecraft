import { craft, log, cron } from "@routecraft/routecraft";

export default craft().id("cron").from(cron("*/1 * * * * *")).to(log());
