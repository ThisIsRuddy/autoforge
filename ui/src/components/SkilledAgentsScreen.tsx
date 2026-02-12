import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  listSkilledAgents, 
  deleteSkilledAgent, 
} from '../lib/api'
import { Plus, Play, Trash2, Edit, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AddAgentModal } from './AddAgentModal'
import { AgentSessionScreen } from './AgentSessionScreen'
import type { SkilledAgent } from '../lib/types'

interface SkilledAgentsScreenProps {
  projectName: string
  onAgentStart?: (agent: SkilledAgent) => void
}

export function SkilledAgentsScreen({ projectName, onAgentStart }: SkilledAgentsScreenProps) {
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState<SkilledAgent | undefined>(undefined)
  const [activeSessionAgent, setActiveSessionAgent] = useState<SkilledAgent | null>(null)
  
  const queryClient = useQueryClient()

  const { data: agents, isLoading } = useQuery({
    queryKey: ['skilled-agents'],
    queryFn: listSkilledAgents
  })

  const deleteMutation = useMutation({
    mutationFn: deleteSkilledAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skilled-agents'] })
    }
  })

  const handleStartSession = (agent: SkilledAgent) => {
    // In a real implementation, this would likely start a specific type of session
    // For now, we'll just set local state to show the session screen
    setActiveSessionAgent(agent)
    if (onAgentStart) {
      onAgentStart(agent)
    }
  }

  const handleEdit = (agent: SkilledAgent) => {
    setEditingAgent(agent)
    setShowAddModal(true)
  }

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this agent configuration?')) {
      deleteMutation.mutate(id)
    }
  }

  const handleCloseModal = () => {
    setShowAddModal(false)
    setEditingAgent(undefined)
  }

  if (activeSessionAgent) {
    return (
      <AgentSessionScreen 
        projectName={projectName}
        agent={activeSessionAgent}
        onBack={() => setActiveSessionAgent(null)}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold font-display">Skilled Agents</h2>
          <p className="text-muted-foreground">
            Configure specialized agents with specific skills and instructions.
          </p>
        </div>
        <Button onClick={() => setShowAddModal(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Agent
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-12">Loading agents...</div>
      ) : agents?.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <h3 className="text-lg font-medium mb-2">No Skilled Agents Configured</h3>
            <p className="text-muted-foreground mb-6 max-w-md text-center">
              Create a specialized agent configuration to handle specific tasks with custom skills and instructions.
            </p>
            <Button onClick={() => setShowAddModal(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create Your First Agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {agents?.map((agent) => (
            <Card key={agent.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center">
                      <Bot className="h-5 w-5 text-primary" />
                    </div>
                    <CardTitle className="text-lg">{agent.name}</CardTitle>
                  </div>
                  <div className="flex gap-1">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => handleEdit(agent)}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(agent.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="line-clamp-2 mt-2 h-10">
                  {agent.config.preprompt || "No custom instructions provided."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 pb-3">
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">Skills</div>
                    <div className="flex flex-wrap gap-1.5">
                      {agent.config.skills.length > 0 ? (
                        agent.config.skills.slice(0, 5).map((skill) => (
                          <Badge key={skill} variant="secondary" className="text-xs px-1.5 py-0 h-5">
                            {skill}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground italic">No specific skills</span>
                      )}
                      {agent.config.skills.length > 5 && (
                        <Badge variant="outline" className="text-xs px-1.5 py-0 h-5">
                          +{agent.config.skills.length - 5}
                        </Badge>
                      )}
                    </div>
                  </div>
                  
                  {agent.config.model && (
                     <div>
                       <div className="text-xs font-medium text-muted-foreground mb-1">Model</div>
                       <div className="text-sm">{agent.config.model}</div>
                     </div>
                  )}
                </div>
              </CardContent>
              <CardFooter className="pt-3 border-t bg-muted/20">
                <Button className="w-full" onClick={() => handleStartSession(agent)}>
                  <Play className="mr-2 h-4 w-4" />
                  Start Session
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {showAddModal && (
        <AddAgentModal
          isOpen={showAddModal}
          onClose={handleCloseModal}
          agentToEdit={editingAgent}
        />
      )}
    </div>
  )
}
