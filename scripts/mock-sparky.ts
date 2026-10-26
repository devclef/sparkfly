/**
 * Tiny mock of the SparkyFitness API for local end-to-end testing:
 *
 *   npm run mock:sparky
 *
 * Implements the endpoints Sparkfly talks to (in-memory):
 *   POST   /api/food-entries         (idempotent on source + source_id)
 *   POST   /api/food-entry-meals
 *   PUT    /api/food-entries/:id, /api/food-entry-meals/:id
 *   DELETE /api/food-entries/:id
 *   DELETE /api/food-entry-meals/:id
 *   GET    /api/meal-types, /api/meals/search, /api/foods/search
 */
import Fastify from 'fastify';

const PORT = Number(process.env.PORT ?? 3010);
const foods = new Map<string, unknown>();
const meals = new Map<string, unknown>();
let nextId = 1;

const app = Fastify({ logger: { level: 'info' } });

app.get('/', async () => ({
  service: 'mock-sparkyfitness',
  hint: 'start sparkfly with SPARKY_URL=http://127.0.0.1:' + PORT,
}));

app.get('/api/meal-types', async () => [
  { id: '1', name: 'breakfast' },
  { id: '2', name: 'lunch' },
  { id: '3', name: 'dinner' },
  { id: '4', name: 'snacks' },
]);

app.get('/api/meals/search', async (req) => {
  const term = String((req.query as Record<string, string>).searchTerm ?? '').toLowerCase();
  return [
    { id: 'meal-tikka-123', name: 'Chicken Tikka Masala', foods: ['chicken', 'rice', 'naan'] },
    { id: 'meal-pasta-456', name: 'Pasta Carbonara', foods: ['pasta', 'bacon', 'egg'] },
  ].filter((m) => !term || m.name.toLowerCase().includes(term));
});

app.get('/api/foods/search', async (req) => {
  const term = String((req.query as Record<string, string>).searchTerm ?? '').toLowerCase();
  return [
    { id: 'food-coffee-1', name: 'Latte', variants: [{ id: 'var-flat', name: 'flat white' }] },
    { id: 'food-coffee-2', name: 'Cappuccino' },
    { id: 'food-chicken-9', name: 'Grilled Chicken' },
  ].filter((f) => !term || f.name.toLowerCase().includes(term));
});

app.post('/api/food-entries', async (req) => {
  const body = req.body as Record<string, unknown>;
  const key = `${body.source ?? ''}:${body.source_id ?? ''}`;
  const existing = foods.get(key);
  if (existing) {
    console.log(`[mock-sparky] UPSERT food entry (source=${key}):`, JSON.stringify(body));
    return { ...existing, ...body, id: existing.id, updated: true };
  }
  const entry = { id: String(nextId++), ...body, created: true };
  foods.set(key, entry);
  console.log(`[mock-sparky] CREATED food entry ${entry.id} (source=${key}):`, JSON.stringify(body));
  return entry;
});

app.post('/api/food-entry-meals', async (req) => {
  const body = req.body as Record<string, unknown>;
  const entry = { id: String(nextId++), ...body, created: true };
  meals.set(entry.id as string, entry);
  console.log(`[mock-sparky] CREATED meal entry ${entry.id}:`, JSON.stringify(body));
  return entry;
});

app.put<{ Params: { id: string } }>('/api/food-entries/:id', async (req, reply) => {
  for (const entry of foods.values()) {
    if ((entry as { id?: string }).id === req.params.id) {
      console.log(`[mock-sparky] UPDATED food entry ${req.params.id}:`, JSON.stringify(req.body));
      return { ...(entry as object), ...(req.body as object), id: req.params.id, updated: true };
    }
  }
  return reply.code(404).send({ error: 'not found' });
});

app.put<{ Params: { id: string } }>('/api/food-entry-meals/:id', async (req, reply) => {
  const existing = meals.get(req.params.id);
  if (!existing) return reply.code(404).send({ error: 'not found' });
  const updated = { ...(existing as object), ...(req.body as object), id: req.params.id, updated: true };
  meals.set(req.params.id, updated);
  console.log(`[mock-sparky] UPDATED meal entry ${req.params.id}:`, JSON.stringify(req.body));
  return updated;
});

app.delete<{ Params: { id: string } }>('/api/food-entries/:id', async (req, reply) => {
  if (!foods.values().some((e) => (e as { id?: string }).id === req.params.id)) {
    return reply.code(404).send({ error: 'not found' });
  }
  console.log(`[mock-sparky] DELETED food entry ${req.params.id}`);
  return { ok: true };
});

app.delete<{ Params: { id: string } }>('/api/food-entry-meals/:id', async (req, reply) => {
  if (!meals.has(req.params.id)) return reply.code(404).send({ error: 'not found' });
  meals.delete(req.params.id);
  console.log(`[mock-sparky] DELETED meal entry ${req.params.id}`);
  return { ok: true };
});

app.listen({ port: PORT, host: '127.0.0.1' }).catch((err) => {
  console.error(err);
  process.exit(1);
});
