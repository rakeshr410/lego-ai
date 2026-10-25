import type { APIRoute } from 'astro';
import { json } from '../../lib/server/http';

export const prerender = false;

/**
 * Liveness: the process is up and serving requests. Checks no dependencies, so a Redis or
 * Strapi outage doesn't get healthy web instances restarted (that's what /api/ready is for).
 */
export const GET: APIRoute = () => json({ status: 'ok' });
