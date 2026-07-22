export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface LegacyTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
}

const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

class InMemoryTaskStore {
  private readonly tasks = new Map<string, LegacyTask>();

  create(taskId: string): LegacyTask {
    const now = new Date().toISOString();
    const task: LegacyTask = {
      taskId,
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttl: 60000,
      pollInterval: 500,
    };
    this.tasks.set(taskId, task);
    return task;
  }

  list(cursor?: string): { tasks: LegacyTask[]; nextCursor?: string } {
    void cursor;
    return { tasks: [...this.tasks.values()] };
  }

  get(taskId: string): LegacyTask | undefined {
    return this.tasks.get(taskId);
  }

  result(taskId: string): unknown {
    const task = this.tasks.get(taskId);
    if (task?.status !== 'completed') {
      throw { code: -32602, message: 'Task is not complete' };
    }
    return { content: [], _meta: { [RELATED_TASK_META_KEY]: { taskId } } };
  }

  cancel(taskId: string): LegacyTask | undefined {
    const task = this.tasks.get(taskId);
    if (task) task.status = 'cancelled';
    return task;
  }
}

export const taskStore = new InMemoryTaskStore();
