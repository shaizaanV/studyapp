import { DurableObject } from 'cloudflare:workers';
import core from './core.js';

const { DirectoryCore } = core;

/** One global instance: code -> room, plus every per-IP limit. Small JSON RPC over fetch. */
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.dir = new DirectoryCore();
    ctx.blockConcurrencyWhile(async () => {
      const snapshot = await ctx.storage.get('snap');
      if (snapshot) this.dir = new DirectoryCore({ snapshot });
    });
  }

  async fetch(request) {
    const body = await request.json();
    const path = new URL(request.url).pathname;
    let result;
    switch (path) {
      case '/create': result = this.dir.create(body.ipHash, body.roomId); break;
      case '/lookup': result = this.dir.lookup(body.code, body.ipHash); break;
      case '/rotate': result = this.dir.rotate(body.roomId); break;
      case '/release': this.dir.release(body.roomId); result = { ok: true }; break;
      default: result = { error: 'invalid' };
    }
    await this.ctx.storage.put('snap', this.dir.snapshot());
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }
}
