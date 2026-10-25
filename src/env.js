// Loads .env for local development. On Vercel, settings come from the project's
// environment variables instead.
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
