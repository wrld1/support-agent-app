import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { executionModeOf, resolveModelConfig } from './config.js';

const port = Number(process.env.PORT || 3000);

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(
    `LaunchShield LiveOps Backend running on http://localhost:${info.port} [mode=${executionModeOf(resolveModelConfig())}]`,
  );
});
