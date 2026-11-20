// MCP: JSON-RPC 2.0 over streamable HTTP at POST /mcp. Both eras the suite accepts:
// modern 2026-07-28 (server/discover, no session) and legacy (initialize +
// notifications/initialized). Plain JSON replies; the client also accepts SSE, but JSON
// is the simpler half of what it reads.

import { Store, VIEWER, type Repo } from './store.ts';

export interface McpOutcome {
  status: number;
  body: unknown | null;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login; the authenticated user when omitted.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'muse-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpOutcome {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(id: unknown, structured: unknown): McpOutcome {
  const text = JSON.stringify(structured);
  return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: structured, isError: false });
}

function toolError(id: unknown, message: string): McpOutcome {
  return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

function missingArg(id: unknown, name: string): McpOutcome {
  return toolError(id, `Missing required argument: ${name}`);
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = args['owner'];
  const name = args['repo'];
  if (typeof name !== 'string') return null;
  if (owner !== undefined && owner !== VIEWER) return null;
  return store.getRepo(name) ?? null;
}

function repoView(store: Store, repo: Repo): Record<string, unknown> {
  return store.repoObject(repo);
}

function callTool(store: Store, id: unknown, name: string, args: Record<string, unknown>): McpOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = args['name'];
      if (typeof repoName !== 'string' || repoName === '') return missingArg(id, 'name');
      const created = store.createRepo(repoName, args['private'] === true, typeof args['description'] === 'string' ? args['description'] : '');
      if (created === null) return toolError(id, `repository ${repoName} already exists`);
      return toolResult(id, repoView(store, created));
    }
    case 'get_repo': {
      if (typeof args['owner'] !== 'string') return missingArg(id, 'owner');
      if (typeof args['repo'] !== 'string') return missingArg(id, 'repo');
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(id, 'Not Found');
      return toolResult(id, repoView(store, repo));
    }
    case 'create_issue': {
      if (typeof args['owner'] !== 'string') return missingArg(id, 'owner');
      if (typeof args['repo'] !== 'string') return missingArg(id, 'repo');
      if (typeof args['title'] !== 'string' || args['title'] === '') return missingArg(id, 'title');
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(id, 'Not Found');
      const created = store.createIssue(repo, args['title'], typeof args['body'] === 'string' ? args['body'] : '');
      if ('error' in created) return toolError(id, created.error);
      return toolResult(id, store.issueObject(repo, created));
    }
    case 'list_issues': {
      if (typeof args['owner'] !== 'string') return missingArg(id, 'owner');
      if (typeof args['repo'] !== 'string') return missingArg(id, 'repo');
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(id, 'Not Found');
      const state = typeof args['state'] === 'string' ? args['state'].toLowerCase() : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((issue) => store.issueObject(repo, issue));
      return toolResult(id, list);
    }
    case 'create_pull_request': {
      for (const field of ['owner', 'repo', 'title', 'head', 'base']) {
        if (typeof args[field] !== 'string' || args[field] === '') return missingArg(id, field);
      }
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(id, 'Not Found');
      const created = store.createPull(
        repo,
        args['head'] as string,
        args['base'] as string,
        args['title'] as string,
        typeof args['body'] === 'string' ? args['body'] : '',
      );
      if ('error' in created) return toolError(id, created.error);
      return toolResult(id, store.pullObject(repo, created));
    }
    case 'merge_pull_request': {
      if (typeof args['owner'] !== 'string') return missingArg(id, 'owner');
      if (typeof args['repo'] !== 'string') return missingArg(id, 'repo');
      if (typeof args['pull_number'] !== 'number') return missingArg(id, 'pull_number');
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(id, 'Not Found');
      const pull = repo.pulls.get(args['pull_number']);
      if (pull === undefined) return toolError(id, `pull request #${args['pull_number']} not found`);
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return toolError(id, merged.error);
      return toolResult(id, { ...store.pullObject(repo, pull), sha: merged.sha, merged: true });
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}

/** POST /mcp: one JSON-RPC request in `text`. Auth is decided by the caller. */
export function handleMcp(store: Store, text: string): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const request = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in request ? request.id : undefined;
  const isNotification = id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};

  // Notifications get a 202 with no body.
  if (isNotification) return { status: 202, body: null };

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        protocolVersion: '2026-07-28',
      });
    case 'initialize': {
      const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params['name'] === 'string' ? params['name'] : '';
      const args = params['arguments'] !== null && typeof params['arguments'] === 'object' ? (params['arguments'] as Record<string, unknown>) : {};
      return callTool(store, id, name, args);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
