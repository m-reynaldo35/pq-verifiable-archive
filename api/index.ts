// Vercel serverless entry point. vercel.json rewrites every request that is not
// a static file in public/ to this function, and Express routes it.
import app from '../src/app.js';

export default app;
