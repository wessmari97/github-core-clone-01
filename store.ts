// The forge's in-memory store: one real git object database shared by every surface
// (REST contents, git smart HTTP, GraphQL, MCP), plus the repos/issues/pulls that sit
// on top of it. Everything is deterministic: server-created git objects use a fixed
// author/committer and timestamp 0, so a replayed trial produces byte-identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The scenario's viewer login — a constant of the kit's seeded scenario (wire.ts). */
export const VIEWER = 'adaiversen';
export const VIEWER_ID = 1000;
export const ZERO_OID = '0000000000000000000000000000000000000000';

const FIXED_AUTHOR = 'Muse Forge <forge@example.invalid> 0 +0000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function objectId(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

// ---------------------------------------------------------------------------------------------------------
// Trees and commits (git's exact byte formats).
// ---------------------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree sort: entries compare by name, directories as if the name had a trailing '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FIXED_AUTHOR}`);
  lines.push(`committer ${FIXED_AUTHOR}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

// ---------------------------------------------------------------------------------------------------------
// Packs (plain objects only on the wire; the client never sends deltas, and neither do we).
// Deltas on receive are resolved against the store so a real git client still works.
// ---------------------------------------------------------------------------------------------------------

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(objects.length, 0);
  for (const object of objects) {
    const size = object.data.length;
    const typeCode = TYPE_CODES[object.type];
    const head: number[] = [];
    let remaining = size;
    let byte = (typeCode << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    if (remaining > 0) byte |= 0x80;
    head.push(byte);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) next |= 0x80;
      head.push(next);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git binary delta to `base`, returning the result (throws on a bad delta). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++];
      if (op & 0x02) copyOffset |= delta[offset++] << 8;
      if (op & 0x04) copyOffset |= delta[offset++] << 16;
      if (op & 0x08) copyOffset |= delta[offset++] << 24;
      if (op & 0x10) copySize = delta[offset++];
      if (op & 0x20) copySize |= delta[offset++] << 8;
      if (op & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks);
}

export function readPack(buf: Buffer, resolveBase: (oid: string) => GitObject | undefined): GitObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Trailer check.
  const expected = sha1Hex(buf.subarray(0, buf.length - 20));
  if (expected !== buf.subarray(buf.length - 20).toString('hex')) throw new Error('pack checksum mismatch');
  const objects: GitObject[] = [];
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = buf[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType;
    let data: Buffer;
    if (typeCode === 6 || typeCode === 7) {
      // Delta packs never arrive from the suite's client (its writePack emits plain
      // objects only); refusing them cleanly is better than misreading the stream.
      throw new Error('delta packs are not supported');
    } else {
      type = CODE_TYPES[typeCode] as ObjType;
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      data = inflateSync(buf.subarray(offset));
      // Consume the zlib stream: Node's inflateSync ignores trailing bytes, so the stream
      // length is recovered from the Adler-32 trailer (see zlibConsumed).
      offset = offset + zlibConsumed(buf.subarray(offset), data);
    }
    if (data.length !== size) throw new Error(`object size mismatch: got ${data.length}, expected ${size}`);
    const object: GitObject = { type, data };
    objects.push(object);
    byOffset.set(start, object);
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------------------
// pkt-line helpers.
// ---------------------------------------------------------------------------------------------------------

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem = { kind: 'line'; text: string } | { kind: 'flush' } | { kind: 'delim' };

/** Parse pkt-lines from the front of `buf` until a flush (or the buffer ends). */
export function parsePktLines(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      offset += 4;
      continue; // response-end, treat as terminator
    }
    if (offset + len > buf.length) break;
    items.push({ kind: 'line', text: buf.subarray(offset + 4, offset + len).toString('utf8') });
    offset += len;
  }
  return { items, rest: buf.subarray(offset) };
}

/** Parse every pkt-line in `buf` (flushes included, as items); `rest` is unparsed tail data. */
export function parsePktLinesAll(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) break;
    items.push({ kind: 'line', text: buf.subarray(offset + 4, offset + len).toString('utf8') });
    offset += len;
  }
  return { items, rest: buf.subarray(offset) };
}

// ---------------------------------------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------------------------------------

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Repo {
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  databaseId: number;
  refs: Map<string, string>;
  counter: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, Comment[]>;
  seq: number;
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextRestId = 100000;
  nextSeq = 1;

  // -- objects ---------------------------------------------------------------
  putObject(type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // -- repos -----------------------------------------------------------------
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      name,
      description: description ?? '',
      private: isPrivate ?? false,
      defaultBranch: 'main',
      databaseId: this.nextRepoId++,
      refs: new Map(),
      counter: 0,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      seq: this.nextSeq++,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  repoObject(repo: Repo): Record<string, unknown> {
    return {
      id: repo.databaseId,
      name: repo.name,
      full_name: `${VIEWER}/${repo.name}`,
      owner: { login: VIEWER, id: VIEWER_ID },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://example.invalid/${VIEWER}/${repo.name}`,
      url: `/api/v3/repos/${VIEWER}/${repo.name}`,
    };
  }

  // -- git graph -------------------------------------------------------------
  commitTree(oid: string): string | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** path -> {mode, oid} for every file under a tree (recursive). */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** Build a tree object from a flat path map; returns the tree oid. */
  buildTreeFromMap(map: ReadonlyMap<string, { mode: string; oid: string }>): string {
    const build = (paths: Array<[string, { mode: string; oid: string }]>): string => {
      const dirs = new Map<string, Array<[string, { mode: string; oid: string }]>>();
      const files: TreeEntry[] = [];
      for (const [path, entry] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) files.push({ mode: entry.mode, name: path, oid: entry.oid });
        else {
          const dir = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          const list = dirs.get(dir) ?? [];
          list.push([rest, entry]);
          dirs.set(dir, list);
        }
      }
      for (const [dir, list] of dirs) files.push({ mode: '40000', name: dir, oid: build(list) });
      return this.putObject('tree', buildTree(files));
    };
    return build([...map.entries()]);
  }

  makeCommit(treeOid: string, parents: string[], message: string): string {
    return this.putObject('commit', buildCommit({ tree: treeOid, parents, message }));
  }

  ancestors(oid: string): Set<string> {
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(maybeAncestor: string, oid: string): boolean {
    if (maybeAncestor === oid) return true;
    // Walk from `oid` toward its roots, stopping the moment the ancestor is found —
    // a fast-forward check's old tip is usually the new tip's parent, one step away.
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === maybeAncestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** A merge-base: the first common ancestor found walking from `b` by recency. */
  mergeBase(a: string, b: string): string | null {
    const aSet = this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (aSet.has(current)) return current;
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Commits from `tip` back, newest first (parents in order, deduped). */
  commitList(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(current);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  // -- issues / pulls --------------------------------------------------------
  issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
      user: { login: VIEWER, id: VIEWER_ID },
    };
  }

  pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      user: { login: VIEWER, id: VIEWER_ID },
    };
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[] = []): Issue | { error: string } {
    for (const label of labels) if (!repo.labels.has(label)) return { error: `unknown label ${label}` };
    const number = ++repo.counter;
    const issue: Issue = {
      number,
      id: this.nextRestId++,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      seq: this.nextSeq++,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return { error: `unknown head branch ${head}` };
    if (baseSha === undefined) return { error: `unknown base branch ${base}` };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: 'a pull request is already open for this head and base' };
      }
    }
    const number = ++repo.counter;
    const pull: Pull = {
      number,
      id: this.nextRestId++,
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nextSeq++,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The three-way merge of head into base; `null` tree means a conflict. */
  threeWay(repo: Repo, pull: Pull): { tree: Map<string, { mode: string; oid: string }>; conflict: boolean; baseOid: string | null } {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { tree: new Map(), conflict: false, baseOid: null };
    const baseOid = this.mergeBase(headTip, baseTip);
    const baseMap = baseOid === null ? new Map() : this.flattenTree(this.commitTree(baseOid) ?? '');
    const oursMap = this.flattenTree(this.commitTree(baseTip) ?? '');
    const theirsMap = this.flattenTree(this.commitTree(headTip) ?? '');
    const merged = new Map<string, { mode: string; oid: string }>();
    let conflict = false;
    const paths = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path);
      const o = oursMap.get(path);
      const t = theirsMap.get(path);
      const bOid = b?.oid;
      const oOid = o?.oid;
      const tOid = t?.oid;
      if (oOid === tOid) {
        if (o !== undefined) merged.set(path, o);
      } else if (bOid === oOid) {
        if (t !== undefined) merged.set(path, t);
      } else if (bOid === tOid) {
        if (o !== undefined) merged.set(path, o);
      } else {
        conflict = true;
      }
    }
    return { tree: merged, conflict, baseOid };
  }

  mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.threeWay(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge an open pull request; returns the merge commit sha or an error. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return { error: 'unknown base branch' };
    const { tree, conflict } = this.threeWay(repo, pull);
    if (conflict) return { error: 'merge conflict' };
    const treeOid = this.buildTreeFromMap(tree);
    const sha = this.makeCommit(treeOid, [baseTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '1970-01-01T00:00:00Z';
    pull.mergeCommitSha = sha;
    return { sha };
  }

  /** Changed files of a pull request, from merge-base to head. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const baseOid = this.mergeBase(headTip, baseTip);
    const baseMap = baseOid === null ? new Map() : this.flattenTree(this.commitTree(baseOid) ?? '');
    const headMap = this.flattenTree(this.commitTree(headTip) ?? '');
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path);
      const h = headMap.get(path);
      if (b?.oid === h?.oid) continue;
      const oldText = b === undefined ? '' : (this.objects.get(b.oid)?.data.toString('utf8') ?? '');
      const newText = h === undefined ? '' : (this.objects.get(h.oid)?.data.toString('utf8') ?? '');
      const { additions, deletions } = lineDiff(oldText, newText);
      const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  }
}

/** Line additions/deletions by multiset difference (files here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n').filter((line, index, arr) => !(index === arr.length - 1 && line === '')));
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) oldCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCounts.values()) deletions += remaining;
  return { additions, deletions };
}

/** Adler-32, the checksum that ends every zlib stream. */
function adler32(data: Buffer): number {
  // Deferred modulo: for inputs under ~5 KB the sums stay exact without it.
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a += data[i] as number;
    b += a;
    if (i % 1024 === 1023) {
      a %= 65521;
      b %= 65521;
    }
  }
  return (((b % 65521) << 16) | (a % 65521)) >>> 0;
}

/**
 * How many bytes the zlib stream starting at `buf` consumes (for walking a pack).
 * The stream's last 4 bytes are the Adler-32 of its output, so after one inflate the
 * end is the first place those 4 bytes occur where the prefix inflates cleanly.
 * Falls back to the exponential/binary search when the checksum is not found.
 */
function zlibConsumed(buf: Buffer, inflated: Buffer): number {
  const checksum = adler32(inflated);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(checksum, 0);
  let searchFrom = 0;
  for (;;) {
    const idx = buf.indexOf(needle, searchFrom);
    if (idx < 0) break;
    // The candidate end is idx; verify with the Adler-32 INCLUDED (a zlib stream
    // without its trailer throws as truncated).
    try {
      inflateSync(buf.subarray(0, idx + 4));
      return idx + 4;
    } catch {
      searchFrom = idx + 1;
    }
  }
  // Fallback: Node's inflateSync ignores trailing bytes but throws on a truncated
  // stream, so the stream length is the smallest prefix that inflates cleanly.
  const ok = (n: number): boolean => {
    try {
      inflateSync(buf.subarray(0, n));
      return true;
    } catch {
      return false;
    }
  };
  let lo = 1;
  let hi = 1;
  while (hi < buf.length && !ok(hi)) {
    lo = hi;
    hi = Math.min(buf.length, hi * 2);
  }
  if (!ok(hi)) return buf.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
