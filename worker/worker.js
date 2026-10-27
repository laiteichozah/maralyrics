import { Hono } from 'hono';
import { cors } from 'hono/cors';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import accountRoutes from './routes/account.js';
import { requireAuth } from './lib/auth.js';

const BLOCKED_COUNTRIES = new Set(['CN', 'RU', 'KP', 'IR']);

const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Every response: no MIME sniffing. Account and admin responses are private, so no browser, proxy or CDN may keep a copy.
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  if (c.req.path.startsWith('/api/v1/account') || c.req.path.startsWith('/api/v1/admin')) c.header('Cache-Control', 'no-store');
  await next();
});

app.use('*', async (c, next) => {
  const country = c.req.raw.cf?.country;
  if (country && BLOCKED_COUNTRIES.has(country)) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
  await next();
});

app.use('/api/v1/admin/*', async (c, next) => {
  if (c.req.path === '/api/v1/admin/auth/login') return next(); // public: no session yet
  return requireAuth(c, next);
});

app.route('/api/v1/account', accountRoutes);
app.route('/api/v1', publicRoutes);
app.route('/api/v1/admin', adminRoutes);

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

// An unexpected failure: the details (SQL, stack, binding names) go to the log, never to the caller.
app.onError((err, c) => {
  console.error(err);
  return c.json({ success: false, error: 'Something went wrong. Please try again.' }, 500);
});

export default app;
