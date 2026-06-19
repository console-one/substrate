/**
 * storage-contract.test.ts — Persistence as explicit obligation.
 *
 * Storage is a tool the Sequence requires. When it's available,
 * writes to persistence-required partitions are persisted via the tick.
 * When unavailable, gaps surface — no silent success.
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
      expect(seq.get('_storage.tool.type')).toBe('sqlite');
      expect(seq.get('_storage.tool.path')).toBe(dbPath);

      // Persistence requirements are also readable
      expect(seq.get('_partitions.state.persistence')).toBe('required');
      expect(seq.get('_partitions.proj.persistence')).toBe('never');

      await server.stop();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  test.skip('storage available → tick results persisted, sync position advances', async () => {
    const dbPath = join(tmpdir(), `ft-sc-ok-${Date.now()}.db`);
    try {
      const server = new ContextGraphServer({ port: 0, dbPath });
      await server.start();
      const seq = server.seq!;

      // Setup: promotion policy + state obligation → tick produces state-partition writes
      seq.mount('bind', 'id.users.alice.role', 'approver');
      seq.mount('bind', 'chan.users.alice.desktop.visible', true);
      seq.mount('bind', 'state.task.status', 'pending');
      seq.mount('bind', '_policies.promotion.test.pathPattern', 'state.task.*');
      seq.mount('bind', '_policies.promotion.test.triggerValue', 'pending');
      seq.mount('bind', '_policies.promotion.test.targetRole', 'approver');
      seq.mount('bind', '_policies.claiming.leaseMs', 300000);

      const syncBefore = seq.get('_storage.tool.lastSyncSeq') as number;

      // Tick produces req.* and proc.* mounts → persistence-required → persisted
      server.tick();

      const syncAfter = seq.get('_storage.tool.lastSyncSeq') as number;
      expect(syncAfter).toBeGreaterThan(syncBefore);

      // No storage gaps
      expect(seq.keys('_storage.gaps').length).toBe(0);

      await server.stop();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  test.skip('storage unavailable → gap surfaced, not silent success', async () => {
    const dbPath = join(tmpdir(), `ft-sc-fail-${Date.now()}.db`);
    try {
      const server = new ContextGraphServer({ port: 0, dbPath });
      await server.start();
      const seq = server.seq!;

      // Setup lifecycle so tick produces persistence-required writes
      seq.mount('bind', 'id.users.alice.role', 'approver');
      seq.mount('bind', 'chan.users.alice.desktop.visible', true);
      seq.mount('bind', 'state.task2.status', 'pending');
      seq.mount('bind', '_policies.promotion.test2.pathPattern', 'state.task2.*');
      seq.mount('bind', '_policies.promotion.test2.triggerValue', 'pending');
      seq.mount('bind', '_policies.promotion.test2.targetRole', 'approver');
      seq.mount('bind', '_policies.claiming.leaseMs', 300000);

      // Degrade storage BEFORE tick
      seq.mount('bind', '_storage.tool.status', 'unavailable');

      // Tick writes to req.* (persistence=required) → storage check fails → gap
      server.tick();

      const gapKeys = seq.keys('_storage.gaps');
      expect(gapKeys.length).toBeGreaterThan(0);

      // Gap is structured
      const firstGap = seq.get(`_storage.gaps.${gapKeys[0]}`) as any;
      expect(firstGap).toBeDefined();
      expect(firstGap.reason).toContain('storage unavailable');
      expect(firstGap.paths).toBeDefined();
      expect(Array.isArray(firstGap.paths)).toBe(true);

      await server.stop();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  test.skip('storage recovery → new writes persist after tool restored — PENDING commitment-lifecycle rewrite', async () => {
    const dbPath = join(tmpdir(), `ft-sc-recover-${Date.now()}.db`);
    try {
      const server = new ContextGraphServer({ port: 0, dbPath });
      await server.start();
      const seq = server.seq!;

      // Setup a request that the tick will fulfill
      seq.mount('bind', 'state.x', 'pending');
      seq.mount('bind', 'req.r1.subject', 'state.x');
      seq.mount('bind', 'req.r1.targetIdentity', 'id.users.alice');
      seq.mount('bind', 'req.r1.status', 'delivered');
      seq.mount('bind', '_policies.claiming.leaseMs', 300000);

      // Degrade storage, then tick → gap
      seq.mount('bind', '_storage.tool.status', 'unavailable');
      server.tick();
      expect(seq.keys('_storage.gaps').length).toBeGreaterThan(0);

      // Recover storage
      seq.mount('bind', '_storage.tool.status', 'available');

      // Next lifecycle action: approve the request → tick fulfills → persists
      seq.mount('bind', 'req.r1.response', 'done');
      server.tick();

      // New sync position should have advanced
      const lastSync = seq.get('_storage.tool.lastSyncSeq') as number;
      expect(lastSync).toBeGreaterThan(0);

      await server.stop();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  test('proj partition writes do not trigger storage gaps when unavailable', async () => {
    const dbPath = join(tmpdir(), `ft-sc-proj-${Date.now()}.db`);
    try {
      const server = new ContextGraphServer({ port: 0, dbPath });
      await server.start();
      const seq = server.seq!;

      seq.mount('bind', '_storage.tool.status', 'unavailable');

      // proj.* has persistence='never' — no gap expected
      seq.mount('bind', 'proj.view.x', 'ephemeral');

      // Tick with no promotion policies → no persistence-required writes from tick
      server.tick();

      // Check: no gaps reference proj paths
      const gapKeys = seq.keys('_storage.gaps');
      for (const gk of gapKeys) {
        const gap = seq.get(`_storage.gaps.${gk}`) as any;
        if (gap?.paths) {
          expect(gap.paths.some((p: string) => p.startsWith('proj.'))).toBe(false);
        }
      }

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
      server1.seq!.mount('bind', 'state.fact', 'durable');
      server1.seq!.mount('bind', 'req.r1.status', 'open');
      server1.tick();
      await server1.stop();

      const server2 = new ContextGraphServer({ port: 0, dbPath });
      await server2.start();
      expect(server2.seq!.get('state.fact')).toBe('durable');
      expect(server2.seq!.get('req.r1.status')).toBe('open');
      expect(server2.seq!.get('_storage.tool.status')).toBe('available');
      await server2.stop();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });
});
