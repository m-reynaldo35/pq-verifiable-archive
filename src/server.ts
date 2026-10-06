// Long-running server entry point (local development or any Node host).
// On Vercel the app is served by api/index.ts instead.
import { app } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, () => {
  console.log(`PQ Verifiable Archive listening on :${PORT}`);
});
