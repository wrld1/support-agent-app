import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { triageTicket } from './agent.js';
import { executionModeOf, resolveModelConfig } from './config.js';
import { PRESET_SCENARIOS } from './data.js';
import { LiveOpsStore } from './store.js';
import { TriageRequestSchema } from './types.js';

export function createApp(store = new LiveOpsStore()): Hono {
  const app = new Hono();

  app.use('/*', logger(), cors());

  app.get('/', (c) =>
    c.json({
      service: 'LaunchShield LiveOps AI Triage Backend',
      status: 'ok',
      executionMode: executionModeOf(resolveModelConfig()),
    }),
  );

  app.get('/api/health', (c) => {
    const config = resolveModelConfig();
    return c.json({
      status: 'ok',
      service: 'launchshield-liveops-backend',
      sdk: 'vercel-ai-sdk',
      provider: config.provider ?? 'deterministic-fallback',
      model: config.modelId,
      executionMode: executionModeOf(config),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/scenarios', (c) =>
    c.json({
      scenarios: PRESET_SCENARIOS,
      store: store.getSnapshot(),
      executionMode: executionModeOf(resolveModelConfig()),
    }),
  );

  app.post('/api/tickets/triage', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const parsed = TriageRequestSchema.safeParse(body);
    if (!parsed.success) {
      console.warn('[triage] rejected payload', parsed.error.flatten().fieldErrors);
      return c.json({ error: 'Invalid ticket payload.', details: parsed.error.flatten().fieldErrors }, 400);
    }

    return c.json(await triageTicket(parsed.data, store));
  });

  app.post('/api/store/reset', (c) => c.json({ status: 'reset', store: store.reset() }));

  app.onError((err, c) => {
    console.error(`[error] ${c.req.method} ${c.req.path}`, err);
    return c.json({ error: err.message || 'Unexpected server error' }, 500);
  });

  return app;
}
