import { craft, log, cron } from "@routecraft/routecraft";

export default craft().id("cron").from(cron("*/60 * * * * *")).to(log());
