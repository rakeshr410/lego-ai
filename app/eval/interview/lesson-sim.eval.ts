import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// A coach lesson run against the real model with the learner silent (docs/coach-mode.md): every move is a
// continue, as the voice's idle wait sends it. It records, per move, what the coach decided, whether the move
// was meant to draw, what the reply drew itself and what the service had to place for it, so a lesson whose
// board stops growing shows without a browser. `npm run eval:ask -- eval/interview/lesson-sim.eval.ts`.
//
//   LESSON_SIM_LESSONS     comma-separated lesson slugs of frontend-foundations (default: dom)
//   LESSON_SIM_MOVES       moves per lesson at most (default 30)
//   LESSON_SIM_OUT         where the report goes (default eval/results/)
//   LESSON_SIM_NAME        what the coach calls the learner (default none)

const { store } = vi.hoisted(() => {
  const map = new Map<string, string>();
  const store = {
    map,
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => void map.set(k, v),
    setNx: async (k: string, v: string) => (map.has(k) ? false : (map.set(k, v), true)),
    del: async (k: string) => void map.delete(k),
    cas: async (k: string, expected: string, v: string) => (map.get(k) !== expected ? false : (map.set(k, v), true)),
    incr: async (k: string) => {
      const n = Number(map.get(k) ?? 0) + 1;
      map.set(k, String(n));
      return n;
    },
    incrByFloat: async (k: string, delta: number) => {
      const n = Number(map.get(k) ?? 0) + delta;
      map.set(k, String(n));
      return n;
    },
  };
  return { store };
});

vi.mock('../../src/lib/server/env', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/lib/server/env')>()), isProduction: () => false }));
vi.mock('../../src/lib/server/store', () => ({ getStore: async () => store }));
vi.mock('../../src/lib/sd', async (importOriginal) => {
  const sd = await importOriginal<typeof import('../../src/lib/sd')>();
  return { ...sd, FLAGS: { ...sd.FLAGS, interview: true, reviewedOnly: false } };
});

function keyFromDotenv(): string | undefined {
  const file = new URL('../../.env', import.meta.url);
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  return line?.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^["']|["']$/g, '') || undefined;
}

type Move = { n: number; move: string; item?: string; draw: boolean; elements: number; ops: string[]; filled: number; text: string };

it('coach lessons with a silent learner', { timeout: 60 * 60_000 }, async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY || keyFromDotenv();
  if (!apiKey) throw new Error('needs ANTHROPIC_API_KEY (env or app/.env)');
  process.env.INTERVIEW_COACH_MONTHLY_SESSIONS = '1000';
  const gw = await import('../../src/lib/server/llm-gateway');
  gw.setAnthropicClient(new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 }) as never);
  const svc = await import('../../src/lib/server/interview/service');
  const { CONSENT_VERSION } = await import('../../src/lib/server/interview/config');

  const lessons = (process.env.LESSON_SIM_LESSONS ?? 'dom').split(',').filter(Boolean);
  const maxMoves = Number(process.env.LESSON_SIM_MOVES ?? 30);
  const report: Record<string, { moves: Move[]; summary: Record<string, number> }> = {};

  // The service logs each move's drawing (event coach_draw): read it off the console.
  const draws: Record<string, unknown>[] = [];
  const log = console.log;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (line.startsWith('{"event":"coach_draw"')) draws.push(JSON.parse(line));
    else if (!line.startsWith('{')) log(...args);
  });

  for (const lesson of lessons) {
    const reader = `sim-${lesson}`.slice(0, 40);
    const { session } = await svc.startSession(reader, 'frontend-foundations', CONSENT_VERSION, { kind: 'coach', lesson, name: process.env.LESSON_SIM_NAME ?? null });
    const moves: Move[] = [];
    for (let n = 1; n <= maxMoves; n++) {
      draws.length = 0;
      const { turn, session: view } = await svc.continueLesson(reader, session.id, {});
      const d = draws[0] as { move: string; item?: string; draw: boolean; elements: number; ops: string[]; filled?: number } | undefined;
      moves.push({ n, move: d?.move ?? '?', item: d?.item, draw: !!d?.draw, elements: d?.elements ?? 0, ops: d?.ops ?? [], filled: d?.filled ?? 0, text: turn.text });
      log(`${lesson} #${n} ${d?.move}${d?.draw ? ' draw' : ''} drew=${(d?.ops.length ?? 0) - (d?.filled ?? 0)} filled=${d?.filled ?? 0} | ${turn.text.slice(0, 110)}`);
      if (view.status !== 'active' || d?.move === 'end') break;
    }
    // A draw review draws only what the learner's board lacks, which the coach may already have drawn.
    const drawMoves = moves.filter((m) => m.draw && m.move !== 'draw_review');
    report[lesson] = {
      moves,
      summary: {
        moves: moves.length,
        drawMoves: drawMoves.length,
        drewThemselves: drawMoves.filter((m) => m.ops.length - m.filled > 0).length,
        neededFill: drawMoves.filter((m) => m.filled > 0).length,
        noPicture: drawMoves.filter((m) => m.ops.length === 0).length,
      },
    };
    log(lesson, JSON.stringify(report[lesson].summary));
  }
  const out = process.env.LESSON_SIM_OUT ?? 'eval/results';
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `lesson-sim-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify(report, null, 2)}\n`);
  // Every move meant to draw puts a picture on the board, the model's or the plan's.
  for (const [lesson, r] of Object.entries(report)) expect(r.summary.noPicture, `${lesson}: draw moves with nothing drawn`).toBe(0);
});
