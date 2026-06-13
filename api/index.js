// Punto de entrada para Vercel (serverless).
// Reutiliza la misma app de Express; las tablas se crean en el primer request.
import app from '../src/server.js';

export default app;
