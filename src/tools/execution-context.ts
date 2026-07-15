import type { ToolContext } from './types.js';

export type ExecutionSurface =
  | 'interactive'
  | 'dag_step'
  | 'subagent_fallback'
  | 'background_job'
  | 'recovery'
  | 'proactive';

export interface SurfaceContextDeclaration {
  provides: Array<keyof ToolContext>;
  unsupported: Array<keyof ToolContext>;
}

export const EXECUTION_CONTEXT_FIELDS = [
  'chatId',
  'tenantId',
  'sessionId',
  'userId',
  'agentId',
  'permissionLevel',
  'scopeGrants',
  'abortSignal',
  'taskId',
  'onArtifact',
  'artifactHints',
  'turnRichArtifactPaths',
  'artifactCoordinator',
  'permissionElevationRequests',
  'writeConfirmedByElevation',
  'executionModel',
] as const satisfies ReadonlyArray<keyof ToolContext>;

type ExecutionContextField = (typeof EXECUTION_CONTEXT_FIELDS)[number];

function declaration(
  provides: ExecutionContextField[],
  unsupported: ExecutionContextField[],
): SurfaceContextDeclaration {
  return { provides, unsupported };
}

export const SURFACE_CONTEXT_DECLARATIONS: Record<ExecutionSurface, SurfaceContextDeclaration> = {
  interactive: declaration(
    [
      'chatId',
      'tenantId',
      'sessionId',
      'userId',
      'agentId',
      'permissionLevel',
      'scopeGrants',
      'abortSignal',
      'onArtifact',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'executionModel',
    ],
    ['taskId'],
  ),
  dag_step: declaration(
    // onArtifact IS provided: detached plan steps create real deliverables
    // (create_artifact), and without the callback those artifacts never reach
    // the session timeline — the user got a container file path in text.
    ['chatId', 'tenantId', 'sessionId', 'agentId', 'permissionLevel', 'scopeGrants', 'abortSignal', 'taskId', 'onArtifact', 'executionModel'],
    [
      'userId',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
    ],
  ),
  subagent_fallback: declaration(
    ['chatId', 'tenantId', 'agentId', 'permissionLevel', 'taskId'],
    [
      'sessionId',
      'userId',
      'scopeGrants',
      'abortSignal',
      'onArtifact',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'executionModel',
    ],
  ),
  background_job: declaration(
    ['abortSignal'],
    [
      'chatId',
      'tenantId',
      'sessionId',
      'userId',
      'agentId',
      'permissionLevel',
      'scopeGrants',
      'taskId',
      'onArtifact',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'executionModel',
    ],
  ),
  recovery: declaration(
    [],
    [...EXECUTION_CONTEXT_FIELDS],
  ),
  proactive: declaration(
    ['tenantId'],
    [
      'chatId',
      'sessionId',
      'userId',
      'agentId',
      'permissionLevel',
      'scopeGrants',
      'abortSignal',
      'taskId',
      'onArtifact',
      'artifactHints',
      'turnRichArtifactPaths',
      'artifactCoordinator',
      'permissionElevationRequests',
      'writeConfirmedByElevation',
      'executionModel',
    ],
  ),
};

export function buildExecutionToolContext(
  surface: ExecutionSurface,
  inputs: Partial<ToolContext>,
): ToolContext {
  const declarationForSurface = SURFACE_CONTEXT_DECLARATIONS[surface];
  const context: ToolContext = { ...inputs };

  for (const key of declarationForSurface.unsupported) {
    delete context[key];
  }

  context.executionContext = {
    surface,
    unsupported: [...declarationForSurface.unsupported],
  };

  return context;
}
