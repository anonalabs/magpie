import { describe, it, expect, vi } from 'vitest';
import { createEnginePool } from '../src/lib/engine-pool.js';

const MODEL = { id: 'small-model' };
const OTHER = { id: 'other-model' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An engine whose unload is observable and can be made slow. */
function fakeEngine(name, { unloadDelay = 0 } = {}) {
  return {
    name,
    alive: true,
    unload: vi.fn(async function unload() {
      if (unloadDelay) await new Promise((r) => setTimeout(r, unloadDelay));
      this.alive = false;
    }),
  };
}

describe('loading', () => {
  it('loads once for captures that start together', async () => {
    // The original bug: the second caller resumed before the first had assigned
    // its result, saw nothing, and started a second full load.
    const create = vi.fn(async () => { await tick(); return fakeEngine('a'); });
    const pool = createEnginePool({ create });

    const [one, two] = await Promise.all([pool.get(MODEL), pool.get(MODEL)]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(one).toBe(two);
  });

  it('does not cache a failed load', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('no gpu'))
      .mockResolvedValueOnce(fakeEngine('b'));
    const pool = createEnginePool({ create });

    await expect(pool.get(MODEL)).rejects.toThrow('no gpu');
    await expect(pool.get(MODEL)).resolves.toMatchObject({ name: 'b' });
  });

  it('reports load progress to everyone waiting', async () => {
    const create = vi.fn(async (model, { onProgress }) => { onProgress({ progress: 0.5 }); return fakeEngine('c'); });
    const pool = createEnginePool({ create });
    const seen = [];
    pool.listeners.add((p) => seen.push(p.progress));

    await pool.get(MODEL);
    expect(seen).toEqual([0.5]);
  });

  it('survives a listener that throws', async () => {
    const create = vi.fn(async (model, { onProgress }) => { onProgress({ progress: 1 }); return fakeEngine('d'); });
    const pool = createEnginePool({ create });
    pool.listeners.add(() => { throw new Error('gone'); });

    await expect(pool.get(MODEL)).resolves.toMatchObject({ name: 'd' });
  });
});

describe('discarding', () => {
  it('finishes unloading before the replacement is built', async () => {
    // The bug this exists to prevent: unload releases state the new engine is
    // claiming, so in parallel it can unload the model that just loaded.
    const order = [];
    const first = fakeEngine('first', { unloadDelay: 20 });
    first.unload.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('unloaded');
    });

    const create = vi.fn()
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(async () => { order.push('created'); return fakeEngine('second'); });

    const pool = createEnginePool({ create });
    await pool.get(MODEL);

    pool.discard();
    const replacement = await pool.get(MODEL);

    expect(order).toEqual(['unloaded', 'created']);
    expect(replacement.name).toBe('second');
  });

  it('builds a fresh engine after a discard', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(fakeEngine('one'))
      .mockResolvedValueOnce(fakeEngine('two'));
    const pool = createEnginePool({ create });

    await pool.get(MODEL);
    pool.discard();

    expect((await pool.get(MODEL)).name).toBe('two');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('unloads the old model when the size changes', async () => {
    const small = fakeEngine('small');
    const create = vi.fn().mockResolvedValueOnce(small).mockResolvedValueOnce(fakeEngine('big'));
    const pool = createEnginePool({ create });

    await pool.get(MODEL);
    await pool.get(OTHER);

    expect(small.unload).toHaveBeenCalled();
  });

  it('reports nothing loaded once discarded', async () => {
    const pool = createEnginePool({ create: async () => fakeEngine('x') });
    await pool.get(MODEL);
    expect(pool.status()).toMatchObject({ loaded: true, modelId: MODEL.id });

    pool.discard();
    expect(pool.status()).toMatchObject({ loaded: false, modelId: null });
  });
});

describe('running requests', () => {
  it('runs one at a time', async () => {
    const pool = createEnginePool({ create: async () => fakeEngine('x') });
    let running = 0;
    let peak = 0;

    await Promise.all([1, 2, 3].map(() => pool.run(MODEL, async () => {
      running++; peak = Math.max(peak, running);
      await tick();
      running--;
    })));

    expect(peak).toBe(1);
  });

  it('gives a queued request the engine that exists when it runs', async () => {
    // The reported failure: a request queued behind one that discarded a faulted
    // engine used to receive the dead handle and report "Model not loaded".
    const create = vi.fn()
      .mockResolvedValueOnce(fakeEngine('faulted'))
      .mockResolvedValueOnce(fakeEngine('rebuilt'));
    const pool = createEnginePool({ create });

    const seen = [];
    const first = pool.run(MODEL, async (engine) => {
      seen.push(engine.name);
      pool.discard();               // the fault, mid-flight
      throw new Error('GPUBuffer was unmapped');
    });
    const second = pool.run(MODEL, async (engine) => { seen.push(engine.name); return 'ok'; });

    await expect(first).rejects.toThrow('unmapped');
    await expect(second).resolves.toBe('ok');
    expect(seen).toEqual(['faulted', 'rebuilt']);
  });

  it('does not let one failure poison the requests behind it', async () => {
    const pool = createEnginePool({ create: async () => fakeEngine('x') });

    const bad = pool.run(MODEL, async () => { throw new Error('boom'); });
    const good = pool.run(MODEL, async () => 'fine');

    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('fine');
  });
});
