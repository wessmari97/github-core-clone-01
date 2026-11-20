// Git smart HTTP: info/refs advertisements (v0 + v2), upload-pack (ls-refs, fetch with
// shallow/deepen) and receive-pack (push with report-status). The wire format follows the
// kit's git-client.ts exactly: what it parses is what we emit.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PKT_FLUSH, Store, VIEWER, ZERO_OID, objectId, parseCommit, parsePktLines, parsePktLinesAll, parseTree, pktLine, readPack, writePack, type GitObject, type PktItem } from './store.ts';

const UPLOAD_CAPS_V0 = 'side-band-64k shallow ofs-delta symref=HEAD:refs/heads/main agent=muse-forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=muse-forge/1.0';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** All refs of a repo, HEAD first: [refname, oid], plus the default-branch tip. */
function refList(store: Store, repoName: string): Array<[string, string]> {
  const repo = store.getRepo(repoName);
  if (repo === undefined) return [];
  const out: Array<[string, string]> = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined) out.push(['HEAD', tip]);
  const names = [...repo.refs.keys()].sort();
  for (const name of names) out.push([name, repo.refs.get(name) as string]);
  return out;
}

function isTagObject(store: Store, oid: string): { target: string } | null {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const text = object.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : { target: match[1] };
}

/** The v0 advertisement for a service. */
function advertisementV0(store: Store, repoName: string, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = refList(store, repoName);
  if (refs.length === 0) {
    // An empty repo still advertises its capabilities, on the `capabilities^{}` pseudo-ref
    // (the client's parser skips that line as a ref but reads the capabilities after NUL).
    // Without this, a first push to an empty repo gets no report-status/side-band-64k.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  for (let index = 0; index < refs.length; index += 1) {
    const [name, oid] = refs[index] as [string, string];
    const suffix = index === 0 ? `\0${caps}` : '';
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement (upload-pack only). */
function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=muse-forge/1.0\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------------------------------------
// Fetch: which objects a want list (with haves and a depth) needs.
// ---------------------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Every object reachable from `oid` (commit, tree, blobs, tag targets). A commit in
 * `stop` (a shallow boundary the client already holds) contributes its tree and blobs,
 * but its parents are NOT held — that is the whole point of a shallow clone. */
function reachableObjects(store: Store, oid: string, into = new Set<string>(), stop = new Set<string>()): Set<string> {
  if (into.has(oid)) return into;
  const object = store.getObject(oid);
  if (object === undefined) return into;
  into.add(oid);
  if (object.type === 'commit') {
    const info = parseCommit(object.data);
    reachableObjects(store, info.tree, into, stop);
    if (!stop.has(oid)) {
      for (const parent of info.parents) reachableObjects(store, parent, into, stop);
    }
  } else if (object.type === 'tree') {
    for (const entry of parseTree(object.data)) reachableObjects(store, entry.oid, into, stop);
  } else if (object.type === 'tag') {
    const target = isTagObject(store, oid);
    if (target !== null) reachableObjects(store, target.target, into, stop);
  }
  return into;
}

function planFetch(store: Store, repoName: string, wants: string[], haves: string[], depth: number | null, previousShallow: string[]): FetchPlan {
  // Everything the client already holds (reachable from its haves, stopping at the
  // previous shallow boundary — beyond it the client holds nothing) is never re-sent.
  const held = new Set<string>();
  const previousShallowSet = new Set(previousShallow);
  for (const have of haves) reachableObjects(store, have, held, previousShallowSet);
  // Distance (edges) from any want, BFS over commit parents.
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((want) => [want, 0] as [string, number]);
  const includedCommits = new Set<string>();
  while (queue.length > 0) {
    const [oid, d] = queue.shift() as [string, number];
    if (dist.has(oid)) continue;
    dist.set(oid, d);
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (depth === null || d < depth) {
      includedCommits.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push([parent, d + 1]);
    }
  }
  // Shallow boundary: the deepest included commits, whose parents were not fetched.
  // Depth N includes distances 0..N-1, so the boundary is distance N-1 (depth 1: the tip).
  const boundary = new Set<string>();
  if (depth !== null) {
    for (const [oid, d] of dist) if (d === depth - 1 && includedCommits.has(oid)) boundary.add(oid);
  }
  const shallow: string[] = [];
  for (const oid of boundary) if (!held.has(oid)) shallow.push(oid);
  // Unshallow: previously shallow commits that are now included and no longer on the boundary.
  const unshallow: string[] = [];
  for (const oid of previousShallow) {
    if (includedCommits.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }
  // Objects: included commits (minus held), their trees and blobs, tags pointing at them.
  const wanted = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    if (held.has(oid) || wanted.has(oid)) return;
    const object = store.getObject(oid);
    if (object !== undefined) wanted.set(oid, object);
  };
  const addTree = (treeOid: string): void => {
    addObject(treeOid);
    const tree = store.getObject(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else addObject(entry.oid);
    }
  };
  for (const oid of includedCommits) {
    if (held.has(oid)) continue;
    addObject(oid);
    const tree = store.commitTree(oid);
    if (tree !== null) addTree(tree);
  }
  // Tags whose target is included ride along.
  const repo = store.getRepo(repoName);
  if (repo !== undefined) {
    for (const [name, oid] of repo.refs) {
      if (!name.startsWith('refs/tags/')) continue;
      const tag = isTagObject(store, oid);
      if (tag !== null && includedCommits.has(tag.target) && !held.has(oid)) addObject(oid);
    }
  }
  // Deterministic order: commits, then trees, then blobs, then tags; each group by oid.
  const byType = (type: string): GitObject[] =>
    [...wanted.values()].filter((object) => object.type === type).sort((a, b) => (objectId(a.type, a.data) < objectId(b.type, b.data) ? -1 : 1));
  const objects = [...byType('commit'), ...byType('tree'), ...byType('blob'), ...byType('tag')];
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

/** Sideband-framed pack data (band 1), chunked under the pkt-line limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65500));
    const frame = Buffer.concat([Buffer.from([1]), chunk]);
    const len = frame.length + 4;
    parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), frame]));
    offset += chunk.length;
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------------------------------------

/** GET /{owner}/{repo}.git/info/refs?service=... */
export async function handleInfoRefs(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, repoName: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const service = url.searchParams.get('service');
  const repo = store.getRepo(repoName);
  if (owner !== VIEWER || repo === undefined || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const wantV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
  const body = wantV2 ? advertisementV2() : advertisementV0(store, repoName, service);
  send(res, 200, `application/x-${service}-advertisement`, body);
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 (ls-refs / fetch) or v0 (fetch). */
export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, repoName: string): Promise<void> {
  const repo = store.getRepo(repoName);
  if (owner !== VIEWER || repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const body = await readBody(req);
  const isV2 = req.headers['git-protocol'] === 'version=2';
  const { items } = parsePktLinesAll(body);
  const lines = items.filter((item): item is { kind: 'line'; text: string } => item.kind === 'line').map((item) => item.text.trimEnd());
  if (isV2) {
    const command = lines[0] ?? '';
    if (command === 'command=ls-refs') {
      handleLsRefs(res, store, repoName, lines.slice(1));
      return;
    }
    if (command === 'command=fetch') {
      handleFetchV2(res, store, repoName, items);
      return;
    }
    sendJson(res, 400, { message: `unknown v2 command ${JSON.stringify(command)}` });
    return;
  }
  // v0 fetch: want/have/done lines across two sections (first want line may carry
  // capabilities after a space).
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
  }
  if (wants.length === 0) {
    sendJson(res, 400, { message: 'fetch with no wants' });
    return;
  }
  const plan = planFetch(store, repoName, wants, haves, depth, []);
  // v0 has no sections: shallow/unshallow lines, then NAK, then the sideband pack.
  const parts: Buffer[] = [];
  if (depth !== null) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPack(writePack(plan.objects)));
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleLsRefs(res: ServerResponse, store: Store, repoName: string, args: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const repo = store.getRepo(repoName) as NonNullable<ReturnType<Store['getRepo']>>;
  const parts: Buffer[] = [];
  const refs = refList(store, repoName).filter(([name]) => name !== 'HEAD');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // The HEAD line only matches a prefix that is a prefix of "HEAD" itself (or no prefix).
  // A prefix like refs/heads/ must not pull HEAD into the answer.
  const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (tip !== undefined && headMatches) {
    parts.push(pktLine(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  } else if (tip === undefined && unborn && headMatches) {
    parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const tag = isTagObject(store, oid);
      if (tag !== null) line += ` peeled:${tag.target}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV2(res: ServerResponse, store: Store, repoName: string, items: PktItem[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const previousShallow: string[] = [];
  let depth: number | null = null;
  let inArgs = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (item.kind !== 'line' || !inArgs) continue;
    const arg = item.text.trimEnd();
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) previousShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = parseInt(arg.slice(7), 10);
    // thin-pack, no-progress, ofs-delta, done, flush: nothing to do.
  }
  if (wants.length === 0) {
    sendJson(res, 400, { message: 'fetch with no wants' });
    return;
  }
  const plan = planFetch(store, repoName, wants, haves, depth, previousShallow);
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    PKT_FLUSH,
  ];
  if (depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST /{owner}/{repo}.git/git-receive-pack — v0 push with report-status. */
export async function handleReceivePack(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, repoName: string): Promise<void> {
  const repo = store.getRepo(repoName);
  if (owner !== VIEWER || repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const body = await readBody(req);
  // A body that is not a pkt-line stream must not crash the server.
  if (body.length < 4 || Number.isNaN(parseInt(body.subarray(0, 4).toString('ascii'), 16))) {
    sendJson(res, 400, { message: 'malformed receive-pack request' });
    return;
  }
  const { items, rest } = parsePktLines(body);
  const lines = items.filter((item): item is { kind: 'line'; text: string } => item.kind === 'line').map((item) => item.text.trimEnd());
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  // The first command line carries the client's capabilities after a NUL.
  let requestSideband = false;
  for (const line of lines) {
    const nul = line.indexOf('\0');
    if (nul >= 0 && line.slice(nul + 1).split(' ').includes('side-band-64k')) requestSideband = true;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+?)(?:\0.*)?$/.exec(line);
    if (match === null) continue;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackError = '';
  if (commands.length > 0 && rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => store.getObject(oid));
      for (const object of objects) store.putObject(object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  for (const command of commands) {
    if (!unpackOk) {
      report.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) report.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else if (current !== command.oldOid) {
      report.push({ ref: command.ref, ok: false, reason: 'old ref does not match' });
      continue;
    }
    const target = store.getObject(command.newOid);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      report.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && !store.isAncestor(command.oldOid, command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push({ ref: command.ref, ok: true, reason: '' });
  }
  const parts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const entry of report) {
    parts.push(pktLine(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
  }
  parts.push(PKT_FLUSH);
  // The report-status stream is pkt-lined; it is sideband-framed (band 1) only when the
  // push requested side-band-64k — otherwise the client reads the lines raw.
  const responseBody = requestSideband
    ? Buffer.concat(
        parts.map((part) => {
          const frame = Buffer.concat([Buffer.from([1]), part]);
          const len = frame.length + 4;
          return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), frame]);
        }),
      )
    : Buffer.concat(parts);
  send(res, 200, 'application/x-git-receive-pack-result', responseBody);
}
