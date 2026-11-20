// The forge's HTTP surface: REST v3 resources, GraphQL v4, MCP and git smart HTTP,
// all on one in-memory store. main.ts (the entry <-> env lifecycle) stays as shipped;
// this file is the server.
//
// Auth: every /api/v3, /api/graphql and /mcp call carries `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN` (the same token is in this process's environment). A missing or
// wrong token is 401; a repository under another owner is 404, never 403. Every JSON
// reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER, VIEWER_ID, parseTree, type Repo } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestCounter}`,
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    const path = new URL(req.url ?? '/', 'http://entry').pathname;
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body: undefined when empty, null when malformed. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The bearer token authorizes; without a known token, any non-empty bearer does. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (SHOP_TOKEN !== '') return header === `Bearer ${SHOP_TOKEN}`;
  return header.startsWith('Bearer ') && header.slice('Bearer '.length).trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Contents helpers.
// ---------------------------------------------------------------------------------------------------------

/** The tree entries of the directory at `path` inside `treeOid` ('' = the root). */
function treeDir(store: Store, treeOid: string, path: string): Array<{ mode: string; name: string; oid: string }> | null {
  let current = treeOid;
  if (path !== '') {
    for (const segment of path.split('/')) {
      const object = store.getObject(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return null;
      current = entry.oid;
    }
  }
  const object = store.getObject(current);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTree(object.data);
}

function resolveRefCommit(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = store.getObject(ref);
    return object !== undefined && object.type === 'commit' ? ref : null;
  }
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// The app.
// ---------------------------------------------------------------------------------------------------------

export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const segments = path.split('/').filter((segment) => segment !== '').map(decodeSegment);

      try {
        // The env's boot check: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root (no auth needed for the root itself).
        if (method === 'GET' && (path === '/' || path === '/api/v3')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -4);
          const suffix = `/${segments.slice(2).join('/')}`;
          if (method === 'GET' && suffix === '/info/refs') {
            await handleInfoRefs(req, res, store, owner, repoName);
            return;
          }
          if (method === 'POST' && suffix === '/git-upload-pack') {
            await handleUploadPack(req, res, store, owner, repoName);
            return;
          }
          if (method === 'POST' && suffix === '/git-receive-pack') {
            await handleReceivePack(req, res, store, owner, repoName);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything below needs the bearer token.
        if (path === '/api/graphql' || path === '/mcp' || path.startsWith('/api/v3')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          sendJson(res, 200, handleGraphQL(store, body));
          return;
        }

        // MCP.
        if (method === 'POST' && path === '/mcp') {
          const raw = await readBody(req);
          const outcome = handleMcp(store, raw.toString('utf8'));
          if (outcome.body === null) {
            res.writeHead(outcome.status, { 'x-github-request-id': `req-${++requestCounter}` });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        // GET /api/v3/user (the token's login).
        if (method === 'GET' && path === '/api/v3/user') {
          sendJson(res, 200, { login: VIEWER, id: VIEWER_ID, name: VIEWER, type: 'User' });
          return;
        }

        // GET /api/v3/meta.
        if (method === 'GET' && path === '/api/v3/meta') {
          sendJson(res, 200, { installed_version: '1.0.0' });
          return;
        }

        // POST /api/v3/user/repos — create a repository.
        if (method === 'POST' && path === '/api/v3/user/repos') {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          const record = isRecord(body) ? body : {};
          const name = typeof record['name'] === 'string' ? record['name'] : '';
          if (name === '') {
            sendJson(res, 422, { message: 'name is required' });
            return;
          }
          const created = store.createRepo(name, record['private'] === true, typeof record['description'] === 'string' ? record['description'] : '');
          if (created === null) {
            sendJson(res, 422, { message: `repository ${name} already exists` });
            return;
          }
          sendJson(res, 201, store.repoObject(created));
          return;
        }

        // GET /api/v3/user/repos — the viewer's repositories, paginated in creation order.
        if (method === 'GET' && path === '/api/v3/user/repos') {
          const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
          const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
          const all = [...store.repos.values()].sort((a, b) => a.seq - b.seq);
          const slice = all.slice((page - 1) * perPage, page * perPage);
          const headers: Record<string, string> = {};
          if (page * perPage < all.length) {
            const host = req.headers.host ?? '127.0.0.1';
            const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
            const lastPage = Math.ceil(all.length / perPage);
            const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
            headers['link'] = `<${next}>; rel="next", <${last}>; rel="last"`;
          }
          sendJson(res, 200, slice.map((repo) => store.repoObject(repo)), headers);
          return;
        }

        // /api/v3/repos/{owner}/{repo}[/...]
        if (segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos' && segments.length >= 4) {
          const owner = segments[3] as string;
          const repoName = segments[4] as string;
          const repo = owner === VIEWER ? store.getRepo(repoName) : undefined;
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const tail = segments.slice(5);

          // GET /repos/{o}/{r}
          if (tail.length === 0 && method === 'GET') {
            sendJson(res, 200, store.repoObject(repo));
            return;
          }
          // PATCH /repos/{o}/{r}
          if (tail.length === 0 && method === 'PATCH') {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            if (isRecord(body) && typeof body['description'] === 'string') repo.description = body['description'];
            if (isRecord(body) && typeof body['default_branch'] === 'string') repo.defaultBranch = body['default_branch'];
            sendJson(res, 200, store.repoObject(repo));
            return;
          }
          // DELETE /repos/{o}/{r}
          if (tail.length === 0 && method === 'DELETE') {
            store.repos.delete(repoName);
            res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
            res.end();
            return;
          }

          // GET /branches
          if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
            const branches = [...repo.refs.entries()]
              .filter(([name]) => name.startsWith('refs/heads/'))
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha } }));
            sendJson(res, 200, branches);
            return;
          }

          // GET /commits[?sha=<ref>]
          if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
            const ref = query.get('sha');
            const tip = resolveRefCommit(store, repo, ref);
            if (tip === null) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const commits = store.commitList(tip).map((sha) => {
              const object = store.getObject(sha);
              const message = object === undefined ? '' : store.getObject(sha)?.type === 'commit' ? ((): string => {
                const text = (object as { data: Buffer }).data.toString('utf8');
                const split = text.indexOf('\n\n');
                return split < 0 ? '' : text.slice(split + 2);
              })() : '';
              return { sha, commit: { message } };
            });
            sendJson(res, 200, commits);
            return;
          }

          // POST /git/refs
          if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            const record = isRecord(body) ? body : {};
            const ref = typeof record['ref'] === 'string' ? record['ref'] : '';
            const sha = typeof record['sha'] === 'string' ? record['sha'] : '';
            if (ref === '' || sha === '' || store.getObject(sha) === undefined) {
              sendJson(res, 422, { message: 'invalid ref or sha' });
              return;
            }
            if (repo.refs.has(ref)) {
              sendJson(res, 422, { message: `ref ${ref} already exists` });
              return;
            }
            repo.refs.set(ref, sha);
            sendJson(res, 201, { ref, object: { sha } });
            return;
          }

          // GET /git/refs[/...] — one ref, or the whole list.
          if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
            if (tail.length === 2) {
              const all = [...repo.refs.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([ref, sha]) => ({ ref, object: { sha } }));
              sendJson(res, 200, all);
              return;
            }
            const ref = `refs/${tail.slice(2).join('/')}`;
            const sha = repo.refs.get(ref);
            if (sha === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            sendJson(res, 200, { ref, object: { sha } });
            return;
          }

          // /contents/{path...}
          if (tail.length >= 1 && tail[0] === 'contents') {
            const contentPath = tail.slice(1).join('/');
            if (method === 'PUT') {
              const body = await readJsonBody(req);
              if (body === null) {
                sendJson(res, 400, { message: 'malformed JSON body' });
                return;
              }
              const record = isRecord(body) ? body : {};
              const branch = typeof record['branch'] === 'string' ? record['branch'] : repo.defaultBranch;
              const parent = repo.refs.get(`refs/heads/${branch}`);
              const baseMap = parent === undefined ? new Map() : store.flattenTree(store.commitTree(parent) ?? '');
              const existing = baseMap.get(contentPath);
              if (typeof record['sha'] === 'string' && (existing === undefined || existing.oid !== record['sha'])) {
                sendJson(res, 409, { message: 'sha does not match the current blob' });
                return;
              }
              if (typeof record['content'] !== 'string') {
                sendJson(res, 400, { message: 'content is required' });
                return;
              }
              const content = Buffer.from(record['content'], 'base64');
              const blobOid = store.putObject('blob', content);
              const nextMap = new Map(baseMap);
              nextMap.set(contentPath, { mode: '100644', oid: blobOid });
              const treeOid = store.buildTreeFromMap(nextMap);
              const commitOid = store.makeCommit(treeOid, parent === undefined ? [] : [parent], typeof record['message'] === 'string' ? record['message'] : `Update ${contentPath}`);
              repo.refs.set(`refs/heads/${branch}`, commitOid);
              const name = contentPath.split('/').pop() ?? contentPath;
              sendJson(res, existing === undefined ? 201 : 200, {
                content: { name, path: contentPath, sha: blobOid, size: content.length, encoding: 'base64' },
                commit: { sha: commitOid },
              });
              return;
            }
            if (method === 'GET') {
              const ref = query.get('ref');
              const tip = resolveRefCommit(store, repo, ref);
              if (tip === null) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              const treeOid = store.commitTree(tip);
              if (treeOid === null) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              const flat = store.flattenTree(treeOid);
              const file = flat.get(contentPath);
              if (file !== undefined) {
                const object = store.getObject(file.oid);
                const content = object === undefined ? Buffer.alloc(0) : object.data;
                const name = contentPath.split('/').pop() ?? contentPath;
                sendJson(res, 200, {
                  type: 'file',
                  name,
                  path: contentPath,
                  sha: file.oid,
                  size: content.length,
                  encoding: 'base64',
                  content: content.toString('base64'),
                });
                return;
              }
              const entries = treeDir(store, treeOid, contentPath);
              if (entries === null) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              sendJson(
                res,
                200,
                entries.map((entry) => ({
                  type: entry.mode === '40000' ? 'dir' : 'file',
                  name: entry.name,
                  path: contentPath === '' ? entry.name : `${contentPath}/${entry.name}`,
                  sha: entry.oid,
                })),
              );
              return;
            }
            if (method === 'DELETE') {
              const body = await readJsonBody(req);
              if (body === null) {
                sendJson(res, 400, { message: 'malformed JSON body' });
                return;
              }
              const record = isRecord(body) ? body : {};
              const branch = typeof record['branch'] === 'string' ? record['branch'] : repo.defaultBranch;
              const parent = repo.refs.get(`refs/heads/${branch}`);
              if (parent === undefined) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              const baseMap = store.flattenTree(store.commitTree(parent) ?? '');
              const existing = baseMap.get(contentPath);
              if (existing === undefined) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              if (typeof record['sha'] === 'string' && record['sha'] !== existing.oid) {
                sendJson(res, 409, { message: 'sha does not match the current blob' });
                return;
              }
              const nextMap = new Map(baseMap);
              nextMap.delete(contentPath);
              const treeOid = store.buildTreeFromMap(nextMap);
              const commitOid = store.makeCommit(treeOid, [parent], typeof record['message'] === 'string' ? record['message'] : `Delete ${contentPath}`);
              repo.refs.set(`refs/heads/${branch}`, commitOid);
              sendJson(res, 200, { commit: { sha: commitOid } });
              return;
            }
          }

          // POST /labels
          if (tail.length === 1 && tail[0] === 'labels' && method === 'POST') {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            const record = isRecord(body) ? body : {};
            const name = typeof record['name'] === 'string' ? record['name'] : '';
            if (name === '') {
              sendJson(res, 422, { message: 'name is required' });
              return;
            }
            if (repo.labels.has(name)) {
              sendJson(res, 422, { message: `label ${name} already exists` });
              return;
            }
            const label = { name, color: typeof record['color'] === 'string' ? record['color'] : '000000' };
            repo.labels.set(name, label);
            sendJson(res, 201, label);
            return;
          }
          // GET /labels
          if (tail.length === 1 && tail[0] === 'labels' && method === 'GET') {
            sendJson(res, 200, [...repo.labels.values()]);
            return;
          }

          // POST /issues
          if (tail.length === 1 && tail[0] === 'issues' && method === 'POST') {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            const record = isRecord(body) ? body : {};
            const title = typeof record['title'] === 'string' ? record['title'] : '';
            if (title === '') {
              sendJson(res, 422, { message: 'title is required' });
              return;
            }
            const labels = Array.isArray(record['labels']) ? record['labels'].filter((entry): entry is string => typeof entry === 'string') : [];
            const created = store.createIssue(repo, title, typeof record['body'] === 'string' ? record['body'] : '', labels);
            if ('error' in created) {
              sendJson(res, 422, { message: created.error });
              return;
            }
            sendJson(res, 201, store.issueObject(repo, created));
            return;
          }

          // GET /issues
          if (tail.length === 1 && tail[0] === 'issues' && method === 'GET') {
            const state = query.get('state') ?? 'open';
            const direction = query.get('direction') ?? 'desc';
            const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
            const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
            let list = [...repo.issues.values()];
            if (state !== 'all') list = list.filter((issue) => issue.state === state);
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
            sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((issue) => store.issueObject(repo, issue)));
            return;
          }

          // GET /issues/{n}
          if (tail.length === 2 && tail[0] === 'issues' && method === 'GET') {
            const issue = repo.issues.get(parseInt(tail[1] as string, 10));
            if (issue === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            sendJson(res, 200, store.issueObject(repo, issue));
            return;
          }

          // PATCH /issues/{n}
          if (tail.length === 2 && tail[0] === 'issues' && method === 'PATCH') {
            const issue = repo.issues.get(parseInt(tail[1] as string, 10));
            if (issue === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            if (isRecord(body) && (body['state'] === 'open' || body['state'] === 'closed')) issue.state = body['state'];
            if (isRecord(body) && typeof body['title'] === 'string') issue.title = body['title'];
            if (isRecord(body) && typeof body['body'] === 'string') issue.body = body['body'];
            sendJson(res, 200, store.issueObject(repo, issue));
            return;
          }

          // POST /issues/{n}/comments
          if (tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments' && method === 'POST') {
            const issue = repo.issues.get(parseInt(tail[1] as string, 10));
            if (issue === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            const record = isRecord(body) ? body : {};
            const comment = { id: store.nextRestId++, body: typeof record['body'] === 'string' ? record['body'] : '' };
            const list = repo.comments.get(issue.number) ?? [];
            list.push(comment);
            repo.comments.set(issue.number, list);
            sendJson(res, 201, comment);
            return;
          }

          // GET /issues/{n}/comments
          if (tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments' && method === 'GET') {
            const issue = repo.issues.get(parseInt(tail[1] as string, 10));
            if (issue === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            sendJson(res, 200, repo.comments.get(issue.number) ?? []);
            return;
          }

          // POST /pulls
          if (tail.length === 1 && tail[0] === 'pulls' && method === 'POST') {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            const record = isRecord(body) ? body : {};
            const head = typeof record['head'] === 'string' ? record['head'] : '';
            const base = typeof record['base'] === 'string' ? record['base'] : '';
            const title = typeof record['title'] === 'string' ? record['title'] : '';
            if (head === '' || base === '' || title === '') {
              sendJson(res, 422, { message: 'head, base and title are required' });
              return;
            }
            const created = store.createPull(repo, head, base, title, typeof record['body'] === 'string' ? record['body'] : '');
            if ('error' in created) {
              sendJson(res, 422, { message: created.error });
              return;
            }
            sendJson(res, 201, store.pullObject(repo, created));
            return;
          }

          // GET /pulls
          if (tail.length === 1 && tail[0] === 'pulls' && method === 'GET') {
            const state = query.get('state') ?? 'open';
            let list = [...repo.pulls.values()];
            if (state !== 'all') list = list.filter((pull) => pull.state === state);
            list.sort((a, b) => b.seq - a.seq);
            sendJson(res, 200, list.map((pull) => store.pullObject(repo, pull)));
            return;
          }

          // GET /pulls/{n}
          if (tail.length === 2 && tail[0] === 'pulls' && method === 'GET') {
            const pull = repo.pulls.get(parseInt(tail[1] as string, 10));
            if (pull === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            sendJson(res, 200, store.pullObject(repo, pull));
            return;
          }

          // GET /pulls/{n}/files
          if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'files' && method === 'GET') {
            const pull = repo.pulls.get(parseInt(tail[1] as string, 10));
            if (pull === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            sendJson(res, 200, store.pullFiles(repo, pull));
            return;
          }

          // PUT /pulls/{n}/merge
          if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'merge' && method === 'PUT') {
            const pull = repo.pulls.get(parseInt(tail[1] as string, 10));
            if (pull === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const merged = store.mergePull(repo, pull);
            if ('error' in merged) {
              if (merged.error === 'merge conflict') {
                sendJson(res, 405, { message: 'merge conflict' });
                return;
              }
              sendJson(res, 422, { message: merged.error });
              return;
            }
            sendJson(res, 200, { sha: merged.sha, merged: true, message: `Merge pull request #${pull.number}` });
            return;
          }
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A request must never crash the server (the suite checks the repo survives errors).
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
