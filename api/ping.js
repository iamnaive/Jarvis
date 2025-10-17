// api/ping.js — Edge healthcheck
export const runtime = 'edge';
export default async function handler(req) {
  if (req.method === 'GET') return new Response('pong', { status: 200 });
  return new Response('ok', { status: 200 });
}
