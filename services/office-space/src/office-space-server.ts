/**
 * office-space-server.ts — Composition of the public packages into
 * the Office Space product server.
 *
 * Extends `@console-one/sequenceutils/transport`'s `ContextGraphServer`
 * with pre-wired `register` + `onTick` hooks that install the
 * lifecycle policies (from `@console-one/sequenceutils/policies`) and
 * base tools (from `@console-one/sequenceutils/tools`). Callers that
 * need additional product-specific rules pass their own `register`
 * / `onTick` in `ServerConfig`; those are chained AFTER the
 * built-in composition so built-in state is already mounted when
 * user rules fire.
 */

import {
  ContextGraphServer as BaseServer,
  NodeStorage,
  type ServerConfig as BaseConfig,
  type PriorSnapshot,
} from '@console-one/sequenceutils/transport';
import { registerLabelRules } from '@console-one/sequenceutils/policies';
import { registerBaseTools } from '@console-one/sequenceutils/tools';
import type { Sequence } from '@console-one/sequence';

export interface ServerConfig extends BaseConfig {
  /** Same shape as the transport's ServerConfig — this wrapper
   *  adds no new fields, only pre-composes the register + onTick
   *  hooks with phase/session/label rules + base tools. */
}

export type { PriorSnapshot };

export class ContextGraphServer extends BaseServer {
  constructor(config: ServerConfig) {
    const storage = config.storage ?? (config.workspaceRoot
      ? new NodeStorage(config.workspaceRoot)
      : new NodeStorage(`${process.cwd()}/workspace`));
    const userRegister = config.register;
    const userOnTick = config.onTick;
    super({
      ...config,
      storage,
      register: (seq: Sequence) => {
        registerLabelRules(seq);
        registerBaseTools(seq, { storage });
        if (userRegister) userRegister(seq);
      },
      onTick: (seq: Sequence) => {
        if (userOnTick) userOnTick(seq);
      },
    });
  }
}
