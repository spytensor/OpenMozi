import type { TaskRecord } from '../store/task-dag.js';
import type { ArtifactEnvelope, ArtifactStatus } from './types.js';

export interface WorkspaceHubTask {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  priority: number;
}

export interface WorkspaceHubData {
  mission: {
    title: string;
    description: string;
    phase: 'planning' | 'executing' | 'completed' | 'failed';
    progress: number;
  };
  team: {
    total_tasks: number;
    completed_tasks: number;
    failed_tasks: number;
    active_tasks: number;
  };
  tasks: WorkspaceHubTask[];
  summary?: string;
  report_markdown?: string;
  meta?: {
    turn_id?: string;
  };
}

function normalizeProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function toFallbackText(data: WorkspaceHubData, status: ArtifactStatus): string {
  const taskLine = `${data.team.completed_tasks}/${data.team.total_tasks} tasks`;
  const statusLine = status === 'running' ? 'in progress' : status;
  const summaryLine = data.summary ? ` ${data.summary.slice(0, 220)}` : '';
  return `[Workspace] ${data.mission.title} — ${statusLine}, ${taskLine}.${summaryLine}`.trim();
}

export function mapTasksForWorkspaceHub(tasks: TaskRecord[]): WorkspaceHubTask[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status === 'failed'
      ? 'failed'
      : task.status === 'completed'
        ? 'done'
        : task.status === 'running'
          ? 'running'
          : 'pending',
    priority: task.priority,
  }));
}

export function buildWorkspaceHubArtifact(params: {
  artifactId: string;
  missionTitle: string;
  missionDescription: string;
  phase: WorkspaceHubData['mission']['phase'];
  progress: number;
  tasks: WorkspaceHubTask[];
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  summary?: string;
  reportMarkdown?: string;
  status: ArtifactStatus;
  collapsedByDefault?: boolean;
  turnId?: string;
}): ArtifactEnvelope {
  const data: WorkspaceHubData = {
    mission: {
      title: params.missionTitle,
      description: params.missionDescription,
      phase: params.phase,
      progress: normalizeProgress(params.progress),
    },
    team: {
      total_tasks: params.tasks.length,
      completed_tasks: params.completedTasks,
      failed_tasks: params.failedTasks,
      active_tasks: params.activeTasks,
    },
    tasks: params.tasks,
    summary: params.summary,
    report_markdown: params.reportMarkdown,
    meta: params.turnId ? { turn_id: params.turnId } : undefined,
  };

  return {
    id: params.artifactId,
    plugin_id: 'workspace_hub_v1',
    title: 'Execution Workspace',
    status: params.status,
    collapsed_by_default: params.collapsedByDefault ?? false,
    fallback_text: toFallbackText(data, params.status),
    data: data as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  };
}
