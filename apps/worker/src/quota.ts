import { DurableObject } from "cloudflare:workers";

/** A single instance for the whole app counts research runs per UTC day. */
export class DailyQuota extends DurableObject<Env> {
  /** Takes one run from today's budget; false once `limit` runs have started today. */
  async take(limit: number): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const saved = await this.ctx.storage.get<{ day: string; runs: number }>("today");
    const runs = saved?.day === day ? saved.runs : 0;
    if (runs >= limit) return false;
    await this.ctx.storage.put("today", { day, runs: runs + 1 });
    return true;
  }
}
