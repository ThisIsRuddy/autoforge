import { LayoutGrid, GitBranch, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type ViewMode = 'kanban' | 'graph' | 'agents'

interface ViewToggleProps {
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
}

/**
 * Toggle button to switch between Kanban, Graph, and Skilled Agents views
 */
export function ViewToggle({ viewMode, onViewModeChange }: ViewToggleProps) {
  return (
    <div className="inline-flex rounded-lg border p-1 bg-background">
      <Button
        variant={viewMode === 'kanban' ? 'default' : 'ghost'}
        size="sm"
        onClick={() => onViewModeChange('kanban')}
        title="Kanban View"
      >
        <LayoutGrid size={16} />
        Kanban
      </Button>
      <Button
        variant={viewMode === 'graph' ? 'default' : 'ghost'}
        size="sm"
        onClick={() => onViewModeChange('graph')}
        title="Dependency Graph View"
      >
        <GitBranch size={16} />
        Graph
      </Button>
      <Button
        variant={viewMode === 'agents' ? 'default' : 'ghost'}
        size="sm"
        onClick={() => onViewModeChange('agents')}
        title="Skilled Agents"
      >
        <Bot size={16} />
        Agents
      </Button>
    </div>
  )
}
