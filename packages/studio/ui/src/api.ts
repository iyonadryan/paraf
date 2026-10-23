import type {
  ApproverTypeInfo,
  ChainInfo,
  FlowDefinition,
  FlowSummary,
  FlowValidationIssue,
  FlowVersionInfo,
  PublishedFlow,
} from '@paraf/core';
import { CSRF_HEADER } from '../../src/shared';
import type { StudioUser } from '../../src/shared';

/** What the studio knows about this session (`GET api/session`). */
export interface Session {
  label: string | null;
  user: StudioUser | null;
  approverTypes: ApproverTypeInfo[];
  chains: ChainInfo[];
  operators: string[];
}

/** One flow with its versions (`GET api/flows/:id`). */
export interface FlowDetail {
  id: string;
  activeVersion: number | null;
  versions: FlowVersionInfo[];
  runningInstances: number;
}

/** A failed API call. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: readonly FlowValidationIssue[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  // Relative to the page, so the studio works wherever it is mounted.
  const response = await fetch(`api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      [CSRF_HEADER]: '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => null)) as
    (T & { error?: string; issues?: FlowValidationIssue[] }) | null;
  if (!response.ok) {
    throw new ApiError(response.status, data?.error ?? response.statusText, data?.issues ?? []);
  }
  return data as T;
}

const flowPath = (id: string) => `flows/${encodeURIComponent(id)}`;

export const api = {
  session: () => call<Session>('GET', 'session'),
  flows: () => call<FlowSummary[]>('GET', 'flows'),
  flow: async (id: string): Promise<FlowDetail> => {
    const detail = await call<FlowDetail>('GET', flowPath(id));
    return {
      ...detail,
      versions: detail.versions.map((version) => ({
        ...version,
        createdAt: new Date(version.createdAt),
      })),
    };
  },
  version: (id: string, version: number) =>
    call<PublishedFlow>('GET', `${flowPath(id)}/versions/${version}`),
  publish: (flow: FlowDefinition, notes: string) =>
    call<PublishedFlow>('POST', 'flows', { flow, notes }),
  activate: (id: string, version: number) =>
    call<{ activeVersion: number }>('POST', `${flowPath(id)}/active`, { version }),
};

/** A published version as an editable draft (without its version number). */
export function toDraft(flow: PublishedFlow): FlowDefinition {
  const { version: _version, ...draft } = flow;
  return draft;
}
