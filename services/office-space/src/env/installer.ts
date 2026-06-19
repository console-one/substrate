/**
 * env/installer.ts — Kit installer tool.
 *
 * A "kit" in Office Space is a bundle of tools, schemas,
 * and classes that can be installed into a running Sequence at
 * runtime — not just at boot. The installer is the mechanism
 * that fetches a kit manifest, validates it, dispatches on the
 * source kind (ft file / inline ft text / remote URL / TS
 * module), and mounts the kit's contents into the target
 * sequence.
 *
 * Architecturally lifted from lens-desktop's manifest system:
 *   - types.ts  → KitManifest + validation errors
 *   - dao.ts    → `KitInstallerDao` validation + fetch
 *   - store.ts  → `KitStore` with per-id tracking at `_kits.{id}`
 *
 * Semantics are different — lens-desktop's manifest is a
 * singleton service-URL registry for an app's backends; here the
 * store tracks multiple installed kits keyed by id, each with its
 * own installation record so uninstall + upgrade work cleanly.
 *
 * What installing a kit does:
 *   1. Validate the manifest (required fields, well-formed source)
 *   2. Dispatch by source kind:
 *        - `ftInline`: run the content through `receive()` into the seq
 *        - `ft`:       read the file from storage, then `ftInline`
 *        - `url`:      fetch the remote manifest, recurse
 *        - `module`:   dynamic import a TS module, call its
 *                      exported `install(seq)` fn
 *   3. Mount `_kits.{id}` with the full manifest so the kernel's
 *      type state records "this kit is installed here now."
 *   4. Return an InstallResult with kit id, source, and any gaps
 *      the kit produced during mount (unresolved obligations
 *      that the caller can attempt to satisfy before use).
 */

import type { Sequence } from '@console-one/sequence';
import { receive } from '@console-one/sequence';
import type { IStorage } from '@console-one/sequenceutils/transport';

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

/** The source a kit gets installed from. Discriminated by `kind`. */
export type KitSource =
  | { kind: 'ftInline'; content: string }
  | { kind: 'ft'; storageKey: string }
  | { kind: 'url'; url: string }
  | { kind: 'module'; import: string };

/**
 * What a kit manifest carries. Minimal shape — Office Space doesn't
 * prescribe a rigid schema for what a kit can do, just enough for
 * the installer to validate and trace installs. The `provides`
 * section is declarative: the kit author lists the tool paths,
 * schema paths, and class names it registers. Nothing enforces
 * that the declared provisions match what the source actually
 * mounts (the kernel records everything either way) — but the
 * declaration lets callers see at a glance what this kit touches.
 */
export interface KitManifest {
  /** Unique kit identifier. Used as the key in `_kits.{id}`. */
  id: string;
  /** Semver string. Two installs with the same id + different
   *  versions = upgrade path (install-over-existing). */
  version: string;
  /** Human-readable description. Shown to users when picking kits. */
  description?: string;
  /** Declared contents — what the install mounts. */
  provides: {
    tools?: string[];
    schemas?: string[];
    classes?: string[];
  };
  /** Declared prerequisites — tool paths this kit invokes. Installer
   *  records them but doesn't block install on missing prereqs;
   *  the unresolved gaps surface on invocation via the kernel's
   *  normal gap mechanism. */
  requires?: {
    tools?: string[];
  };
  /** How to install. */
  source: KitSource;
}

/** Result of an install attempt. */
export interface InstallResult {
  ok: boolean;
  id: string;
  /** Number of mount results the source produced. Zero means the
   *  source was empty or rejected; non-zero means something landed. */
  mountCount: number;
  /** Any gaps reported from the source's mounts. */
  gaps: Array<{ path: string; reason: string }>;
  /** Error message when ok is false. */
  error?: string;
}

/** Installed-kit record emitted by `list()`. */
export interface InstalledKit {
  id: string;
  version: string;
  description?: string;
  installedAt: number;
}

/** Error thrown when a manifest fails validation. */
export class KitValidationError extends Error {
  constructor(message: string, public readonly details: string[] = []) {
    super(message);
    this.name = 'KitValidationError';
  }
}

/** Error thrown when the source cannot be read/fetched. */
export class KitSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KitSourceError';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a manifest object. Throws `KitValidationError` with a
 * collected list of problems if anything is off. Returns the
 * manifest (narrowed) on success.
 */
export function validateKitManifest(data: unknown): KitManifest {
  const errors: string[] = [];
  if (!data || typeof data !== 'object') {
    throw new KitValidationError('Kit manifest is not an object');
  }
  const m = data as Record<string, unknown>;

  if (!isNonEmptyString(m.id)) errors.push('id: missing or empty');
  if (!isNonEmptyString(m.version)) errors.push('version: missing or empty');

  // provides is required (even if empty) so callers can always
  // iterate the declared contents without null checks.
  if (!m.provides || typeof m.provides !== 'object') {
    errors.push('provides: missing or not an object');
  }

  // source is required and must match one of the known shapes.
  const src = m.source as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') {
    errors.push('source: missing or not an object');
  } else {
    const kind = src.kind;
    switch (kind) {
      case 'ftInline':
        if (!isNonEmptyString(src.content)) errors.push('source.content: missing or empty for kind=ftInline');
        break;
      case 'ft':
        if (!isNonEmptyString(src.storageKey)) errors.push('source.storageKey: missing or empty for kind=ft');
        break;
      case 'url':
        if (!isNonEmptyString(src.url)) errors.push('source.url: missing or empty for kind=url');
        break;
      case 'module':
        if (!isNonEmptyString(src.import)) errors.push('source.import: missing or empty for kind=module');
        break;
      default:
        errors.push(`source.kind: unknown kind "${String(kind)}"`);
    }
  }

  if (errors.length > 0) {
    throw new KitValidationError(
      `Kit manifest validation failed with ${errors.length} error(s)`,
      errors,
    );
  }

  return m as unknown as KitManifest;
}

// ═══════════════════════════════════════════════════════════════════════
// INSTALLER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Injectable into `KitInstaller.install` to resolve the different
 * source kinds. Each env supplies its own impls — Unix uses
 * `NodeStorage` for `ft` sources and `fetch()` for `url` sources;
 * browser will use an in-memory blob map for `ft` and `window.fetch`
 * for `url`; Lambda uses S3 or inline bundles.
 */
export interface KitResolver {
  /** Read a kit source file from local storage. */
  readFt(storageKey: string): Promise<string>;
  /** Fetch a remote kit manifest URL. Returns the raw response body. */
  fetchUrl(url: string): Promise<string>;
  /** Dynamic import a TS/JS module by path. Must export a default
   *  or named `install(seq): Promise<void>` function. */
  loadModule(importPath: string): Promise<{ install: (seq: Sequence) => Promise<void> }>;
}

/**
 * Main installer. Constructed with an env-specific resolver and
 * operates on any Sequence. Multi-instance friendly — a server can
 * have one, a Unix env client can have another, and they don't
 * share state.
 */
export class KitInstaller {
  constructor(private readonly resolver: KitResolver) {}

  /**
   * Install a kit. Validates the manifest first, then dispatches
   * to the source handler. Mounts `_kits.{id}` as the last step
   * so the installation record only lands on success — if the
   * source throws, the kit is not marked installed.
   */
  async install(seq: Sequence, manifest: KitManifest): Promise<InstallResult> {
    try {
      validateKitManifest(manifest);
    } catch (e: any) {
      return {
        ok: false,
        id: (manifest as any)?.id ?? '',
        mountCount: 0,
        gaps: [],
        error: e?.message ?? 'validation failed',
      };
    }

    let mountCount = 0;
    const gaps: Array<{ path: string; reason: string }> = [];

    try {
      switch (manifest.source.kind) {
        case 'ftInline': {
          const result = (receive as any)(manifest.source.content, seq);
          mountCount = result.mounts?.length ?? 0;
          collectGaps(result.mounts ?? [], gaps);
          break;
        }
        case 'ft': {
          const content = await this.resolver.readFt(manifest.source.storageKey);
          const result = (receive as any)(content, seq);
          mountCount = result.mounts?.length ?? 0;
          collectGaps(result.mounts ?? [], gaps);
          break;
        }
        case 'url': {
          const body = await this.resolver.fetchUrl(manifest.source.url);
          // Remote URL response is assumed to be ft text. A future
          // extension can negotiate content type (application/ft
          // vs application/json+manifest) and dispatch to a nested
          // manifest install.
          const result = (receive as any)(body, seq);
          mountCount = result.mounts?.length ?? 0;
          collectGaps(result.mounts ?? [], gaps);
          break;
        }
        case 'module': {
          const mod = await this.resolver.loadModule(manifest.source.import);
          if (typeof mod.install !== 'function') {
            throw new KitSourceError(`module "${manifest.source.import}" has no exported install(seq) function`);
          }
          await mod.install(seq);
          mountCount = 1; // opaque — the module did whatever it wanted
          break;
        }
      }
    } catch (e: any) {
      return {
        ok: false,
        id: manifest.id,
        mountCount,
        gaps,
        error: e?.message ?? String(e),
      };
    }

    // Record the installation. Uses batched mounts so the block is
    // atomic: either the whole kit record lands or none of it
    // does (matches the transactional feel of the source mounts).
    const installedAt = Date.now();
    seq.mount([
      { op: 'bind', path: `_kits.${manifest.id}.id`, value: manifest.id },
      { op: 'bind', path: `_kits.${manifest.id}.version`, value: manifest.version },
      { op: 'bind', path: `_kits.${manifest.id}.installedAt`, value: installedAt },
      { op: 'bind', path: `_kits.${manifest.id}.source.kind`, value: manifest.source.kind },
      ...(manifest.description
        ? [{ op: 'bind' as const, path: `_kits.${manifest.id}.description`, value: manifest.description }]
        : []),
    ]);

    return { ok: true, id: manifest.id, mountCount, gaps };
  }

  /**
   * Uninstall clears the `_kits.{id}` record. It does NOT try to
   * unmount the tools/schemas/classes the kit installed — that
   * would require a reverse index of what each kit touched, and
   * kits may share paths. A clean uninstall is a follow-up; for
   * now "uninstall" just drops the tracking record so the kit
   * stops appearing in `list()`.
   */
  async uninstall(seq: Sequence, kitId: string): Promise<void> {
    for (const field of ['id', 'version', 'installedAt', 'description', 'source']) {
      seq.mount('delete', `_kits.${kitId}.${field}`, undefined);
    }
    seq.mount('delete', `_kits.${kitId}`, undefined);
  }

  /**
   * List all installed kits. Reads `_kits.*` and returns the
   * metadata for each. Gaps in the record (e.g., half-written
   * from a crashed install) are skipped — list only reports
   * kits with a complete installation record.
   */
  list(seq: Sequence): InstalledKit[] {
    const out: InstalledKit[] = [];
    for (const id of seq.keys('_kits')) {
      const kid = seq.get(`_kits.${id}.id`);
      const version = seq.get(`_kits.${id}.version`);
      const installedAt = seq.get(`_kits.${id}.installedAt`);
      if (typeof kid !== 'string' || typeof version !== 'string' || typeof installedAt !== 'number') {
        continue; // partial/corrupt record
      }
      const description = seq.get(`_kits.${id}.description`);
      out.push({
        id: kid,
        version,
        description: typeof description === 'string' ? description : undefined,
        installedAt,
      });
    }
    return out;
  }
}

/** Collect any gap results into the caller's gap array. */
function collectGaps(
  mounts: Array<{ ok?: boolean; gaps?: Array<{ path: string; reason: string }> }>,
  into: Array<{ path: string; reason: string }>,
): void {
  for (const m of mounts) {
    if (m.ok === false && m.gaps) {
      for (const g of m.gaps) {
        into.push({ path: g.path, reason: g.reason });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// NODE RESOLVER — Unix / Docker / Lambda
// ═══════════════════════════════════════════════════════════════════════

/**
 * Default resolver for Node-runtime envs. Uses the injected
 * `IStorage` for `ft` sources (so path-traversal guards apply)
 * and the Node `fetch()` for `url` sources. Module loading uses
 * the ESM dynamic `import()`, which Jest + tsx both handle.
 *
 * The browser env will supply its own `BrowserResolver` that uses
 * `window.fetch`, an in-memory blob map for `ft`, and
 * `import('dataUrl')` for `module`.
 */
export class NodeKitResolver implements KitResolver {
  constructor(private readonly storage: IStorage) {}

  async readFt(storageKey: string): Promise<string> {
    return this.storage.read(storageKey);
  }

  async fetchUrl(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new KitSourceError(`fetchUrl ${url}: HTTP ${res.status}`);
    return res.text();
  }

  async loadModule(importPath: string): Promise<{ install: (seq: Sequence) => Promise<void> }> {
    const mod: any = await import(importPath);
    return mod.default?.install
      ? mod.default
      : mod;
  }
}
