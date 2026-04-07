import { useCLITaskStore } from '../../stores/cliTaskStore'
import type { CLITask } from '../../types/cliTask'

const statusConfig = {
  pending: {
    icon: 'radio_button_unchecked',
    color: 'var(--color-text-tertiary)',
    label: 'pending',
  },
  in_progress: {
    icon: 'pending',
    color: 'var(--color-warning)',
    label: 'active',
  },
  completed: {
    icon: 'check_circle',
    color: 'var(--color-success)',
    label: 'done',
  },
} as const

export function SessionTaskBar() {
  const { tasks, expanded, toggleExpanded } = useCLITaskStore()

  if (tasks.length === 0) return null

  const completedCount = tasks.filter((t) => t.status === 'completed').length
  const totalCount = tasks.length
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
      {/* Header — always visible, clickable to toggle */}
      <button
        onClick={toggleExpanded}
        className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--color-surface-hover)] transition-colors"
      >
        <span
          className="material-symbols-outlined text-[16px]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          checklist
        </span>

        <span className="text-xs font-semibold text-[var(--color-text-primary)]">
          Tasks
        </span>

        {/* Progress bar */}
        <div className="flex-1 h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden max-w-[200px]">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${progressPercent}%`,
              backgroundColor: completedCount === totalCount
                ? 'var(--color-success)'
                : 'var(--color-brand)',
            }}
          />
        </div>

        <span className="text-[10px] text-[var(--color-text-tertiary)] tabular-nums">
          {completedCount}/{totalCount}
        </span>

        <span
          className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)] transition-transform duration-200"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          expand_less
        </span>
      </button>

      {/* Expanded task list */}
      {expanded && (
        <div className="px-4 pb-2 flex flex-col gap-0.5 max-h-[240px] overflow-y-auto">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  )
}

function TaskItem({ task }: { task: CLITask }) {
  const config = statusConfig[task.status]

  return (
    <div className="flex items-start gap-2 py-1.5 px-1 rounded-md">
      <span
        className="material-symbols-outlined text-[16px] mt-px shrink-0"
        style={{ color: config.color, fontVariationSettings: "'FILL' 1" }}
      >
        {config.icon}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono text-[var(--color-text-tertiary)]">
            #{task.id}
          </span>
          <span className={`text-xs ${
            task.status === 'completed'
              ? 'text-[var(--color-text-tertiary)] line-through'
              : 'text-[var(--color-text-primary)]'
          }`}>
            {task.subject}
          </span>
        </div>

        {task.status === 'in_progress' && task.activeForm && (
          <div className="flex items-center gap-1 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse" />
            <span className="text-[10px] text-[var(--color-warning)]">
              {task.activeForm}
            </span>
          </div>
        )}

        {task.owner && (
          <span className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 inline-flex items-center gap-0.5">
            <span className="material-symbols-outlined text-[10px]">person</span>
            {task.owner}
          </span>
        )}
      </div>
    </div>
  )
}
