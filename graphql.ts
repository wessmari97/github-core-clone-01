// GraphQL v4: a small executor for the suite's 17 fixed documents (checks-graphql.ts
// GRAPHQL_DOCUMENTS). It is a real parser + resolver over the shared store — no general
// GraphQL engine, but every shape the documents use: aliases, variables, inline enum
// lists, inline input objects, null variables, operation names, fragments, batching.

import { Store, VIEWER, type Repo, type Issue, type Pull } from './store.ts';

// ---------------------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, never the plain number/databaseId.
// ---------------------------------------------------------------------------------------------------------

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`).toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Parser for the document subset the suite sends.
// ---------------------------------------------------------------------------------------------------------

type Token =
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'punct'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      tokens.push({ type: 'int', value: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ type: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    tokens.push({ type: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

type Selection =
  | { kind: 'field'; alias?: string; name: string; args: Array<[string, ValueNode]>; children?: Selection[] }
  | { kind: 'fragment'; typeName?: string; children: Selection[] };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.type} ${'value' in token ? token.value : ''}`);
  }

  /** Skip a balanced (...) group (variable definitions). */
  private skipParens(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.type === 'punct' && token.value === '(') depth += 1;
      else if (token.type === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  parseDocument(): Operation {
    const first = this.peek();
    let type: 'query' | 'mutation' = 'query';
    if (first?.type === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = first.value;
      this.next();
    }
    let name: string | undefined;
    const maybeName = this.peek();
    if (maybeName?.type === 'name') {
      name = maybeName.value;
      this.next();
    }
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '(') this.skipParens();
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.type === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  parseSelection(): Selection {
    const token = this.peek();
    if (token?.type === 'punct' && token.value === '...') {
      this.next();
      let typeName: string | undefined;
      const next = this.peek();
      if (next?.type === 'name' && next.value === 'on') {
        this.next();
        const typeToken = this.next();
        if (typeToken.type === 'name') typeName = typeToken.value;
      }
      return { kind: 'fragment', typeName, children: this.parseSelectionSet() };
    }
    const nameToken = this.next();
    if (nameToken.type !== 'name') throw new Error('expected a field name');
    let alias: string | undefined;
    let name = nameToken.value;
    const colon = this.peek();
    if (colon?.type === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      const actual = this.next();
      if (actual.type !== 'name') throw new Error('expected a field name after an alias');
      name = actual.value;
    }
    let args: Array<[string, ValueNode]> = [];
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
    let children: Selection[] | undefined;
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '{') children = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, children };
  }

  parseArguments(): Array<[string, ValueNode]> {
    this.expectPunct('(');
    const args: Array<[string, ValueNode]> = [];
    for (;;) {
      const token = this.peek();
      if (token?.type === 'punct' && token.value === ')') {
        this.next();
        return args;
      }
      const nameToken = this.next();
      if (nameToken.type !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args.push([nameToken.value, this.parseValue()]);
    }
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      const nameToken = this.next();
      if (nameToken.type !== 'name') throw new Error('expected a variable name');
      return { kind: 'var', name: nameToken.value };
    }
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'int') return { kind: 'int', value: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.type === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next?.type === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
      }
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      for (;;) {
        const next = this.peek();
        if (next?.type === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const nameToken = this.next();
        if (nameToken.type !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        fields.push([nameToken.value, this.parseValue()]);
      }
    }
    throw new Error(`unexpected value token ${token.type}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Values: the resolver graph. Objects carry __type plus hidden _-prefixed data.
// ---------------------------------------------------------------------------------------------------------

type GqlObject = { __type: string; [key: string]: unknown };
type Resolver = (obj: GqlObject, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'var':
      return ctx.variables[node.name];
    case 'string':
    case 'int':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, value] of node.fields) out[name] = evalValue(value, ctx);
      return out;
    }
  }
}

function evalArgs(args: Array<[string, ValueNode]>, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of args) out[name] = evalValue(value, ctx);
  return out;
}

function repoObject(ctx: ExecCtx, repo: Repo): GqlObject {
  return { __type: 'Repository', _store: ctx.store, _repo: repo };
}

function issueObject(ctx: ExecCtx, repo: Repo, issue: Issue): GqlObject {
  return { __type: 'Issue', _store: ctx.store, _repo: repo, _issue: issue };
}

function pullObject(ctx: ExecCtx, repo: Repo, pull: Pull): GqlObject {
  return { __type: 'PullRequest', _store: ctx.store, _repo: repo, _pull: pull };
}

function repoKey(repo: Repo): string {
  return `${VIEWER}/${repo.name}`;
}

function issueId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repoKey(repo)}/${issue.number}`);
}

function pullId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repoKey(repo)}/${pull.number}`);
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`).toString('base64');
}

function cursorSeq(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const seq = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(seq) ? seq : null;
  } catch {
    return null;
  }
}

// The schema surface the introspection probes read.
const TYPE_INFO: Record<string, { fields: string[]; enumValues?: string[] }> = {
  Issue: {
    fields: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  },
  PullRequest: {
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'author'],
  },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'],
  },
  SearchType: {
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  },
  User: { fields: ['id', 'login', 'name'] },
  IssueConnection: { fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { fields: ['nodes', 'pageInfo', 'totalCount'] },
};

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'Viewer' }),
    repository: (_obj, args, ctx) => {
      const owner = args['owner'];
      const name = args['name'];
      if (owner !== VIEWER || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(name);
      return repo === undefined ? null : repoObject(ctx, repo);
    },
    node: (_obj, args, ctx) => {
      const decoded = typeof args['id'] === 'string' ? decodeGlobalId(args['id']) : null;
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const name = decoded.key.split('/').slice(1).join('/');
        const repo = ctx.store.getRepo(name);
        return repo === undefined ? null : repoObject(ctx, repo);
      }
      if (decoded.kind === 'Issue') {
        const parts = decoded.key.split('/');
        const repo = ctx.store.getRepo(parts.slice(1, -1).join('/'));
        const issue = repo?.issues.get(parseInt(parts[parts.length - 1] as string, 10));
        return repo !== undefined && issue !== undefined ? issueObject(ctx, repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const parts = decoded.key.split('/');
        const repo = ctx.store.getRepo(parts.slice(1, -1).join('/'));
        const pull = repo?.pulls.get(parseInt(parts[parts.length - 1] as string, 10));
        return repo !== undefined && pull !== undefined ? pullObject(ctx, repo, pull) : null;
      }
      return null;
    },
    __type: (_obj, args) => {
      const name = args['name'];
      if (typeof name !== 'string') return null;
      const info = TYPE_INFO[name];
      if (info === undefined) return null;
      return { __type: '__Type', _name: name, _fields: info.fields, _enumValues: info.enumValues ?? [] };
    },
  },
  Viewer: {
    login: () => VIEWER,
  },
  User: {
    login: () => VIEWER,
    id: () => globalId('User', VIEWER),
    name: () => VIEWER,
  },
  Repository: {
    id: (obj) => globalId('Repository', repoKey(obj._repo as Repo)),
    databaseId: (obj) => (obj._repo as Repo).databaseId,
    name: (obj) => (obj._repo as Repo).name,
    nameWithOwner: (obj) => repoKey(obj._repo as Repo),
    owner: () => ({ __type: 'User' }),
    defaultBranchRef: (obj) => {
      const repo = obj._repo as Repo;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __type: 'Ref', _name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (obj) => (obj._repo as Repo).description,
    private: (obj) => (obj._repo as Repo).private,
    issue: (obj, args, ctx) => {
      const repo = obj._repo as Repo;
      const issue = typeof args['number'] === 'number' ? repo.issues.get(args['number']) : undefined;
      return issue === undefined ? null : issueObject(ctx, repo, issue);
    },
    issues: (obj, args, ctx) => {
      const repo = obj._repo as Repo;
      let list = [...repo.issues.values()];
      const states = args['states'];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
      }
      const orderBy = args['orderBy'] as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction === 'ASC' ? 1 : -1;
      list.sort((a, b) => (a.seq - b.seq) * direction);
      const afterSeq = cursorSeq(args['after']);
      if (afterSeq !== null) {
        const index = list.findIndex((issue) => issue.seq === afterSeq);
        if (index >= 0) list = list.slice(index + 1);
      }
      const first = typeof args['first'] === 'number' ? args['first'] : list.length;
      const nodes = list.slice(0, first);
      const hasNextPage = list.length > nodes.length;
      const endCursor = nodes.length > 0 ? cursorFor((nodes[nodes.length - 1] as Issue).seq) : null;
      return {
        __type: 'IssueConnection',
        _nodes: nodes.map((issue) => issueObject(ctx, repo, issue)),
        _pageInfo: { __type: 'PageInfo', _hasNextPage: hasNextPage, _endCursor: endCursor },
      };
    },
    pullRequests: (obj, args, ctx) => {
      const repo = obj._repo as Repo;
      const list = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.seq - a.seq);
      const first = typeof args['first'] === 'number' ? args['first'] : list.length;
      return {
        __type: 'PullRequestConnection',
        _nodes: list.slice(0, first).map((pull) => pullObject(ctx, repo, pull)),
        _pageInfo: { __type: 'PageInfo', _hasNextPage: list.length > first, _endCursor: null },
      };
    },
    pullRequest: (obj, args, ctx) => {
      const repo = obj._repo as Repo;
      const pull = typeof args['number'] === 'number' ? repo.pulls.get(args['number']) : undefined;
      return pull === undefined ? null : pullObject(ctx, repo, pull);
    },
  },
  Ref: {
    name: (obj) => obj._name as string,
  },
  Issue: {
    id: (obj) => issueId(obj._repo as Repo, obj._issue as Issue),
    number: (obj) => (obj._issue as Issue).number,
    title: (obj) => (obj._issue as Issue).title,
    body: (obj) => (obj._issue as Issue).body,
    state: (obj) => ((obj._issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
  },
  PullRequest: {
    id: (obj) => pullId(obj._repo as Repo, obj._pull as Pull),
    number: (obj) => (obj._pull as Pull).number,
    title: (obj) => (obj._pull as Pull).title,
    body: (obj) => (obj._pull as Pull).body,
    state: (obj) => {
      const pull = obj._pull as Pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (obj) => (obj._pull as Pull).merged,
    headRefName: (obj) => (obj._pull as Pull).headRef,
    baseRefName: (obj) => (obj._pull as Pull).baseRef,
    mergeable: (obj) => {
      const store = obj._store as Store;
      return store.mergeableOf(obj._repo as Repo, obj._pull as Pull);
    },
    files: (obj, args, ctx) => {
      const store = obj._store as Store;
      const repo = obj._repo as Repo;
      const pull = obj._pull as Pull;
      const first = typeof args['first'] === 'number' ? args['first'] : 100;
      const files = store.pullFiles(repo, pull).slice(0, first);
      return {
        __type: 'PullRequestFileConnection',
        _nodes: files.map((file) => ({ __type: 'PullRequestChangedFile', _path: file.filename })),
      };
    },
  },
  PullRequestChangedFile: {
    path: (obj) => obj._path as string,
  },
  IssueConnection: {
    nodes: (obj) => obj._nodes as GqlObject[],
    pageInfo: (obj) => obj._pageInfo as GqlObject,
  },
  PullRequestConnection: {
    nodes: (obj) => obj._nodes as GqlObject[],
    pageInfo: (obj) => obj._pageInfo as GqlObject,
  },
  PullRequestFileConnection: {
    nodes: (obj) => obj._nodes as GqlObject[],
  },
  PageInfo: {
    hasNextPage: (obj) => obj._hasNextPage as boolean,
    endCursor: (obj) => obj._endCursor as string | null,
  },
  __Type: {
    name: (obj) => obj._name as string,
    fields: (obj) => (obj._fields as string[]).map((name) => ({ __type: '__Field', _name: name })),
    enumValues: (obj) => (obj._enumValues as string[]).map((name) => ({ __type: '__EnumValue', _name: name })),
  },
  __Field: {
    name: (obj) => obj._name as string,
  },
  __EnumValue: {
    name: (obj) => obj._name as string,
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args['input'] ?? {}) as { repositoryId?: string; title?: string; body?: string };
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const repo = ctx.store.getRepo(decoded.key.split('/').slice(1).join('/'));
      if (repo === undefined) {
        ctx.errors.push({ message: 'createIssue: unknown repository' });
        return null;
      }
      const created = ctx.store.createIssue(repo, input.title ?? '', input.body ?? '');
      if ('error' in created) {
        ctx.errors.push({ message: `createIssue: ${created.error}` });
        return null;
      }
      return { __type: 'CreateIssuePayload', _issue: issueObject(ctx, repo, created) };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args['input'] ?? {}) as { issueId?: string };
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      const parts = decoded.key.split('/');
      const repo = ctx.store.getRepo(parts.slice(1, -1).join('/'));
      const issue = repo?.issues.get(parseInt(parts[parts.length - 1] as string, 10));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        return null;
      }
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', _issue: issueObject(ctx, repo, issue) };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args['input'] ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'Repository') {
        ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const repo = ctx.store.getRepo(decoded.key.split('/').slice(1).join('/'));
      if (repo === undefined) {
        ctx.errors.push({ message: 'createPullRequest: unknown repository' });
        return null;
      }
      const created = ctx.store.createPull(repo, input.headRefName ?? '', input.baseRefName ?? '', input.title ?? '', input.body ?? '');
      if ('error' in created) {
        ctx.errors.push({ message: `createPullRequest: ${created.error}` });
        return null;
      }
      return { __type: 'CreatePullRequestPayload', _pull: pullObject(ctx, repo, created) };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args['input'] ?? {}) as { pullRequestId?: string; mergeMethod?: string };
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      const parts = decoded.key.split('/');
      const repo = ctx.store.getRepo(parts.slice(1, -1).join('/'));
      const pull = repo?.pulls.get(parseInt(parts[parts.length - 1] as string, 10));
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return null;
      }
      const merged = ctx.store.mergePull(repo, pull);
      if ('error' in merged) {
        ctx.errors.push({ message: `mergePullRequest: ${merged.error}` });
        return null;
      }
      return { __type: 'MergePullRequestPayload', _pull: pullObject(ctx, repo, pull) };
    },
    addComment: (_obj, args, ctx) => {
      const input = (args['input'] ?? {}) as { subjectId?: string; body?: string };
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      if (decoded === null || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const parts = decoded.key.split('/');
      const repo = ctx.store.getRepo(parts.slice(1, -1).join('/'));
      const issue = repo?.issues.get(parseInt(parts[parts.length - 1] as string, 10));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'addComment: unknown issue' });
        return null;
      }
      const comment = { id: ctx.store.nextRestId++, body: input.body ?? '' };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      return {
        __type: 'AddCommentPayload',
        _edge: {
          __type: 'CommentEdge',
          _node: { __type: 'Comment', _id: globalId('IssueComment', `${repoKey(repo)}/${issue.number}/${comment.id}`), _body: comment.body },
        },
      };
    },
  },
  CreateIssuePayload: {
    issue: (obj) => obj._issue as GqlObject,
  },
  CloseIssuePayload: {
    issue: (obj) => obj._issue as GqlObject,
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => obj._pull as GqlObject,
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => obj._pull as GqlObject,
  },
  AddCommentPayload: {
    commentEdge: (obj) => obj._edge as GqlObject,
  },
  CommentEdge: {
    node: (obj) => obj._node as GqlObject,
  },
  Comment: {
    id: (obj) => obj._id as string,
    body: (obj) => obj._body as string,
  },
};

function resolveValue(value: unknown, children: Selection[] | undefined, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, children, ctx));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    if (children === undefined) return value;
    return resolveSelection(value as GqlObject, children, ctx);
  }
  return value;
}

function resolveSelection(obj: GqlObject, selections: Selection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeName === undefined || selection.typeName === obj.__type) {
        Object.assign(out, resolveSelection(obj, selection.children, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolver = RESOLVERS[obj.__type]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${obj.__type}".` });
      out[key] = null;
      continue;
    }
    const args = evalArgs(selection.args, ctx);
    const value = resolver(obj, args, ctx);
    out[key] = resolveValue(value, selection.children, ctx);
  }
  return out;
}

/** Execute one {query, variables} document; returns the GraphQL response body. */
export function executeGraphQL(store: Store, query: unknown, variables: unknown): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: ExecCtx = {
    store,
    variables: variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {},
    errors: [],
  };
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'no query document' }] };
  }
  let operation: Operation;
  try {
    operation = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `parse error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __type: rootType };
  const data = resolveSelection(root, operation.selections, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** POST /api/graphql: one document, or a JSON array of documents (batching). */
export function handleGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'bad operation document' }] };
      const record = entry as Record<string, unknown>;
      return executeGraphQL(store, record['query'], record['variables']);
    });
  }
  if (body === null || typeof body !== 'object') return { data: null, errors: [{ message: 'bad operation document' }] };
  const record = body as Record<string, unknown>;
  return executeGraphQL(store, record['query'], record['variables']);
}
