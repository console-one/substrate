/**
 * storage-contract.test.ts — Persistence as explicit obligation.
 *
 * Re-expressed on the v2 transport (deletion-ledger stage 4): the
 * store is the ft journal, written per applied delta (no tick). The
 * contract is unchanged: the persistence posture is READABLE facts
 * (_storage.tool.*, _partitions.*.persistence); an owed write that
 * cannot land surfaces as a _storage.gaps.* fact — no silent success.
 */

import { ContextGraphServer } from '../office-space-server.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('storage tool contract', () => {

  test('storage tool mounted and readable on boot', async () => {
    const dbPath = join(tmpdir(), `ft-sc-boot-${Date.now()}.db`);
    try {
      const server = new ContextGraphServer({ port: 0, dbPath });
      await server.start();
      const seq = server.seq!;

      expect(seq.get('_storage.tool.status')).toBe('available');
      expect(seq.get('_storage.tool.type')).toBe('ft-journal');
      expect(seq.get('_storage.tool.path')).toBe(`${dbPath}.ft`);

      // Persistence requirements are also readable
      expect(seq.get('_partitions.state.persistence')).toBe('required');
      expect(seq.get('_partitions.proj.persistence')).toBe('never');

      await server.stop();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  test.todo('storage available → tick results persisted, sync position advances — per-delta journal replaced the tick persistence pass at stage 4');

  test.todo('storage unavailable → gap surfaced, not silent success — live coverage moved to the proj-partition test below (degraded-store gaps)');

  test.todo('storage recovery → new writes persist after tool restored — PENDING commitment-lifecycle rewrite — v1 tick/promotion machinery; re-express when the v2 recovery flow is designed');

  test('proj partition writes do not trigger storage gaps when unavailable', async () => {
    const dbPath = join(tmpdir(), `ft-sc-proj-${Date.now()}.db`);
    try {
      const server = new ContextGraphServer({ port: 0, dbPath });
      await server.start();
      const seq = server.seq!;

      seq.insert({ path: '_storage.tool.status', value: 'unavailable' });

      // proj.* has persistence='never' — no gap expected…
      seq.insert({ path: 'proj.view.x', value: 'ephemeral' });
      // …while a state-partition write that IS owed persistence gaps
      // LOUDLY under the degraded store.
      seq.insert({ path: 'state.task.status', value: 'pending' });

      const gapKeys = seq.keys('_storage.gaps');
      expect(gapKeys.length).toBeGreaterThan(0);
      const gaps = gapKeys.map((gk) => seq.get(`_storage.gaps.${gk}`) as { paths?: string[]; reason?: string });
      for (const gap of gaps) {
        expect(gap.paths!.some((p: string) => p.startsWith('proj.'))).toBe(false);
      }
      expect(gaps.some((g) => g.paths!.includes('state.task.status'))).toBe(true);
      expect(gaps.some((g) => String(g.reason).includes('storage unavailable'))).toBe(true);

      await server.stop();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  test('data survives restart via snapshot persistence', async () => {
    const dbPath = join(tmpdir(), `ft-sc-restart-${Date.now()}.db`);
    try {
      const server1 = new ContextGraphServer({ port: 0, dbPath });
      await server1.start();
      server1.seq!.insert({ path: 'state.fact', value: 'durable' });
      server1.seq!.insert({ path: 'req.r1.status', value: 'open' });
      await server1.stop();

      const server2 = new ContextGraphServer({ port: 0, dbPath });
      await server2.start();
      expect(server2.seq!.get('state.fact')).toBe('durable');
      expect(server2.seq!.get('req.r1.status')).toBe('open');
      expect(server2.seq!.get('_storage.tool.status')).toBe('available');
      await server2.stop();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(`${dbPath}.ft`)) unlinkSync(`${dbPath}.ft`);
    }
  });
});
