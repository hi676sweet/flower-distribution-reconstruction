import { createApp } from './app';

async function main() {
  const { app, close } = await createApp();
  const port = Number(process.env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  await app.listen(port, process.env.HOST ?? '127.0.0.1');
  console.log(`Stocklane is ready at http://${process.env.HOST ?? '127.0.0.1'}:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
