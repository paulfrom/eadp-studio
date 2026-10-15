import { createApp } from './app.js';
import { loadConfig } from './config.js';
try {
  const config = loadConfig(), app = createApp(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  await app.listen({ host: config.host, port: config.port });
  console.log(`Collaboration API listening on ${config.host}:${config.port}`);
} catch { console.error('Collaboration API could not start. Verify local configuration and service availability.'); process.exitCode = 1; }
