import { describe, it, expect, vi, afterEach } from 'vitest';
import { PROVIDERS, getProvider, missingFields, push, loadFieldOptions } from '../src/lib/providers/registry.js';

const capture = {
  title: 'A Page',
  url: 'https://example.com/a',
  content: 'The distilled summary.',
  capturedAt: '2026-09-11T00:00:00.000Z',
  mode: 'distill',
};

function mockFetch(status, payload) {
  // A real Response carries `ok` as well as `status`; omitting it made every
  // `res.ok` check read as a failure.
  const spy = vi.fn().mockResolvedValue({
    status, ok: status >= 200 && status < 300, json: async () => payload,
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const sentBody = (spy) => JSON.parse(spy.mock.calls[0][1].body);
const sentHeaders = (spy) => spy.mock.calls[0][1].headers;

afterEach(() => vi.unstubAllGlobals());

describe('registry', () => {
  it('exposes every provider under its own id', () => {
    for (const [id, provider] of Object.entries(PROVIDERS)) expect(provider.id).toBe(id);
  });

  it('reports missing required fields by label, and ignores optional ones', () => {
    expect(missingFields(getProvider('anona'), {})).toEqual(['API key', 'Space']);
    expect(missingFields(getProvider('anona'), { apiKey: 'k', spaceId: 'default' })).toEqual([]);
    expect(missingFields(getProvider('supermemory'), { apiKey: 'k' })).toEqual([]);
  });

  it('refuses to send when the provider is not configured', async () => {
    const spy = mockFetch(200, {});
    const res = await push('anona', capture, {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not_configured');
    expect(spy).not.toHaveBeenCalled();
  });

  it('turns an unreachable host into an error rather than a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));
    const res = await push('anona', capture, { apiKey: 'k', spaceId: 'default' });
    expect(res).toMatchObject({ ok: false, code: 'network' });
  });

  it('survives an error response that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 502, ok: false, json: async () => { throw new SyntaxError('Unexpected token <'); },
    }));
    const res = await push('anona', capture, { apiKey: 'k', spaceId: 'default' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
  });
});

describe('anona', () => {
  it('sends exactly the fields the API models declare', async () => {
    // Anona's request models are extra="forbid", so a stray or misspelled key is
    // a 422 rather than a silent drop. Pin the exact key set.
    const spy = mockFetch(201, { job_id: 'job_1', status: 'processing' });
    await push('anona', capture, { apiKey: 'anona_live_x', spaceId: 'notes' });

    expect(Object.keys(sentBody(spy)).sort())
      .toEqual(['async', 'content', 'metadata', 'space_id', 'tags']);
  });

  it('uses the "async" alias, not the Python field name', async () => {
    const spy = mockFetch(201, { job_id: 'job_1' });
    await push('anona', capture, { apiKey: 'k', spaceId: 'default' });

    const body = sentBody(spy);
    expect(body.async).toBe(true);
    expect(body).not.toHaveProperty('async_');
  });

  it('never sends a tag under the reserved anona: prefix', async () => {
    const spy = mockFetch(201, {});
    await push('anona', capture, { apiKey: 'k', spaceId: 'default' });
    for (const tag of sentBody(spy).tags) expect(tag.startsWith('anona:')).toBe(false);
  });

  it('reports a queued write as queued, not stored', async () => {
    mockFetch(201, { job_id: 'job_1', status: 'processing' });
    const res = await push('anona', capture, { apiKey: 'k', spaceId: 'default' });
    expect(res).toMatchObject({ ok: true, id: 'job_1', state: 'queued' });
  });

  it('reads the {error:{code,message}} envelope, not FastAPI\'s detail', async () => {
    mockFetch(403, { error: { code: 'space_read_only', message: 'Read-only member attempted a write' } });
    const res = await push('anona', capture, { apiKey: 'k', spaceId: 'default' });
    expect(res).toMatchObject({ ok: false, code: 'space_read_only' });
    expect(res.message).toMatch(/Read-only/);
  });
});

describe('mem0', () => {
  it('authenticates with Token, not Bearer', async () => {
    const spy = mockFetch(200, { event_id: 'evt_1' });
    await push('mem0', capture, { apiKey: 'm0-x', userId: 'u1' });
    expect(sentHeaders(spy).Authorization).toBe('Token m0-x');
  });

  it('posts to the v3 add endpoint with a user_id', async () => {
    const spy = mockFetch(200, { event_id: 'evt_1' });
    await push('mem0', capture, { apiKey: 'k', userId: 'u1' });

    expect(spy.mock.calls[0][0]).toBe('https://api.mem0.ai/v3/memories/add/');
    expect(sentBody(spy).user_id).toBe('u1');
    expect(sentBody(spy).messages[0].content).toContain('The distilled summary.');
  });

  it('treats an event_id as acceptance, not storage', async () => {
    mockFetch(200, { event_id: 'evt_1' });
    const res = await push('mem0', capture, { apiKey: 'k', userId: 'u1' });
    expect(res.state).toBe('queued');
  });
});

describe('supermemory', () => {
  it('keys the document on the page url so re-remembering updates it', async () => {
    const spy = mockFetch(200, { id: 'doc_1', status: 'queued' });
    await push('supermemory', capture, { apiKey: 'k' });
    expect(sentBody(spy).customId).toBe('magpie:https://example.com/a');
  });

  it('omits the container tag entirely when none is set', async () => {
    const spy = mockFetch(200, { id: 'doc_1' });
    await push('supermemory', capture, { apiKey: 'k', containerTag: '' });
    expect(sentBody(spy)).not.toHaveProperty('containerTag');
    expect(sentBody(spy)).not.toHaveProperty('containerTags');
  });

  it('sends the singular containerTag, not the deprecated array', async () => {
    // The plural form is deprecated on v3 and rejected on v4.
    const spy = mockFetch(200, { id: 'doc_1' });
    await push('supermemory', capture, { apiKey: 'k', containerTag: 'reading' });
    expect(sentBody(spy).containerTag).toBe('reading');
    expect(sentBody(spy)).not.toHaveProperty('containerTags');
  });

  it('has no picker, because there is no endpoint that lists tags', async () => {
    const res = await loadFieldOptions('supermemory', 'containerTag', { apiKey: 'k' });
    expect(res.ok).toBe(false);
  });

  it('reports a finished document as stored', async () => {
    mockFetch(200, { id: 'doc_1', status: 'done' });
    const res = await push('supermemory', capture, { apiKey: 'k' });
    expect(res).toMatchObject({ ok: true, id: 'doc_1', state: 'stored' });
  });
});


describe('anona space listing', () => {
  const withKey = { apiKey: 'anona_live_x', spaceId: 'default' };

  it('refuses to call the API before there is a key to call it with', async () => {
    const spy = mockFetch(200, {});
    const res = await loadFieldOptions('anona', 'spaceId', { spaceId: 'default' });
    expect(res).toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('lists spaces from the slash-less collection route with a bearer key', async () => {
    const spy = mockFetch(200, { spaces: [{ space_id: 'notes', name: 'Notes' }], total: 1 });
    await loadFieldOptions('anona', 'spaceId', withKey);

    // A trailing slash here answers 307, which some clients will not replay.
    expect(spy.mock.calls[0][0]).toBe('https://api.anonalabs.com/v1/spaces');
    expect(spy.mock.calls[0][1].headers.Authorization).toBe('Bearer anona_live_x');
  });

  it('addresses a shared space by its qualified id, and says who shared it', async () => {
    mockFetch(200, { spaces: [
      { space_id: 'default', name: 'Default' },
      { space_id: 'default', name: 'Default', shared_by: 'Acme', qualified_id: 'acme:default' },
    ], total: 2 });

    const res = await loadFieldOptions('anona', 'spaceId', withKey);

    // Both are named "default"; the bare form would be refused as ambiguous, so
    // the shared one must be offered under its qualified id.
    expect(res.options.map((o) => o.value)).toEqual(['default', 'acme:default']);
    expect(res.options[1].note).toBe('shared by Acme');
    expect(res.options[0].note).toBe('');
  });

  it('falls back to the space id when a space has no name', async () => {
    mockFetch(200, { spaces: [{ space_id: 'raw-id', name: '' }], total: 1 });
    const res = await loadFieldOptions('anona', 'spaceId', withKey);
    expect(res.options[0].label).toBe('raw-id');
  });

  it('reports an empty account as an empty list, not an error', async () => {
    mockFetch(200, { spaces: [], total: 0 });
    const res = await loadFieldOptions('anona', 'spaceId', withKey);
    expect(res).toMatchObject({ ok: true });
    expect(res.options).toEqual([]);
  });

  it('surfaces a rejected key as a message rather than an empty list', async () => {
    mockFetch(401, { error: { code: 'invalid_api_key', message: 'API key not recognised' } });
    const res = await loadFieldOptions('anona', 'spaceId', withKey);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not recognised/);
  });

  it('does not throw when the network is gone — typing the name still works', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));
    const res = await loadFieldOptions('anona', 'spaceId', withKey);
    expect(res).toMatchObject({ ok: false });
    expect(res.message).toMatch(/Could not reach/);
  });

  it('has nothing to load for a provider that lists nothing', async () => {
    const res = await loadFieldOptions('mem0', 'userId', { apiKey: 'k' });
    expect(res.ok).toBe(false);
  });
});


describe('mem0 user listing', () => {
  const withKey = { apiKey: 'm0-x', userId: 'alice' };

  it('lists entities with a Token header', async () => {
    const spy = mockFetch(200, { results: [] });
    await loadFieldOptions('mem0', 'userId', withKey);
    expect(spy.mock.calls[0][0]).toBe('https://api.mem0.ai/v1/entities/');
    expect(spy.mock.calls[0][1].headers.Authorization).toBe('Token m0-x');
  });

  it('offers only users, never agents, apps or runs', async () => {
    // The endpoint is named "get users" and returns every entity kind.
    mockFetch(200, { results: [
      { id: '1', name: 'alice', type: 'user', total_memories: 12 },
      { id: '2', name: 'support-bot', type: 'agent' },
      { id: '3', name: 'run-7', type: 'run' },
      { id: '4', name: 'bob', type: 'user' },
    ] });

    const res = await loadFieldOptions('mem0', 'userId', withKey);
    expect(res.options.map((o) => o.value)).toEqual(['alice', 'bob']);
    expect(res.options[0].note).toBe('12 memories');
    expect(res.options[1].note).toBe('');
  });

  it('refuses to call before there is a key', async () => {
    const spy = mockFetch(200, {});
    const res = await loadFieldOptions('mem0', 'userId', { userId: 'alice' });
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a rejected key rather than an empty user list', async () => {
    mockFetch(401, { detail: 'Invalid token.' });
    const res = await loadFieldOptions('mem0', 'userId', withKey);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Invalid token/);
  });
});
