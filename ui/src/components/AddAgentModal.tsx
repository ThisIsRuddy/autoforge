import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createSkilledAgent,
  updateSkilledAgent,
  listAvailableSkills,
  getAvailableModels
} from '../lib/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SkilledAgent, SkilledAgentCreate } from '../lib/types'

interface AddAgentModalProps {
  isOpen: boolean
  onClose: () => void
  agentToEdit?: SkilledAgent
}

interface FormData {
  name: string
  preprompt: string
  skills: string[]
  model?: string
}

export function AddAgentModal({ isOpen, onClose, agentToEdit }: AddAgentModalProps) {
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [skillSearch, setSkillSearch] = useState('')
  const queryClient = useQueryClient()

  const { register, handleSubmit, setValue, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    defaultValues: {
      name: '',
      preprompt: '',
      skills: [],
      model: undefined
    }
  })

  // Reset form when modal opens or agentToEdit changes
  useEffect(() => {
    if (isOpen) {
      if (agentToEdit) {
        setValue('name', agentToEdit.name)
        setValue('preprompt', agentToEdit.config.preprompt)
        setSelectedSkills(agentToEdit.config.skills)
        setValue('model', agentToEdit.config.model)
      } else {
        reset()
        setSelectedSkills([])
      }
    }
  }, [isOpen, agentToEdit, setValue, reset])

  const { data: skills, isLoading: skillsLoading } = useQuery({
    queryKey: ['available-skills'],
    queryFn: listAvailableSkills,
    enabled: isOpen
  })

  const { data: modelsData } = useQuery({
    queryKey: ['available-models'],
    queryFn: getAvailableModels,
    enabled: isOpen
  })

  const createMutation = useMutation({
    mutationFn: createSkilledAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skilled-agents'] })
      onClose()
    }
  })

  const updateMutation = useMutation({
    mutationFn: (data: { id: number, update: any }) => updateSkilledAgent(data.id, data.update),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skilled-agents'] })
      onClose()
    }
  })

  const onSubmit = async (data: FormData) => {
    const payload = {
      name: data.name,
      config: {
        skills: selectedSkills,
        preprompt: data.preprompt,
        model: data.model || undefined
      }
    }

    if (agentToEdit) {
      await updateMutation.mutateAsync({ id: agentToEdit.id, update: payload })
    } else {
      await createMutation.mutateAsync(payload as SkilledAgentCreate)
    }
  }

  const toggleSkill = (skillName: string) => {
    setSelectedSkills(prev =>
      prev.includes(skillName)
        ? prev.filter(s => s !== skillName)
        : [...prev, skillName]
    )
  }

  const filteredSkills = skills?.filter(skill =>
    skill.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
    skill.description.toLowerCase().includes(skillSearch.toLowerCase())
  ) || []

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{agentToEdit ? 'Edit Skilled Agent' : 'Create Skilled Agent'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-hidden flex flex-col gap-4">
          <ScrollArea className="flex-1 pr-4">
            <div className="space-y-6 p-1">
              {/* Basic Info */}
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label htmlFor="name">Agent Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g., Frontend Specialist"
                    {...register('name', { required: 'Name is required' })}
                  />
                  {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="model">Model (Optional)</Label>
                  <Select
                    onValueChange={(val: string) => setValue('model', val === 'default' ? undefined : val)}
                    defaultValue={agentToEdit?.config.model || "default"}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a model (Default: Project Default)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Use Project Default</SelectItem>
                      {modelsData?.models.map(model => (
                        <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="preprompt">Instructions (System Prompt)</Label>
                  <Textarea
                    id="preprompt"
                    placeholder="Describe how this agent should behave, what tone to use, and any specific rules to follow..."
                    className="h-32 font-mono text-sm"
                    {...register('preprompt', { required: 'Instructions are required' })}
                  />
                  {errors.preprompt && <p className="text-sm text-destructive">{errors.preprompt.message}</p>}
                </div>
              </div>

              {/* Skills Selection */}
              <div className="space-y-4 border rounded-md p-4 bg-muted/30">
                <div className="flex justify-between items-center">
                  <Label className="text-base">Capabilities & Skills</Label>
                  <Badge variant="secondary">{selectedSkills.length} selected</Badge>
                </div>

                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search available skills..."
                    className="pl-9"
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                  />
                </div>

                {skillsLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-2">
                    {filteredSkills.length > 0 ? (
                      filteredSkills.map((skill) => (
                        <div
                          key={skill.name}
                          className={`flex items-start space-x-3 p-3 rounded-md border cursor-pointer transition-colors ${selectedSkills.includes(skill.name)
                              ? 'bg-primary/5 border-primary/30'
                              : 'hover:bg-accent/50 border-transparent bg-card'
                            }`}
                          onClick={() => toggleSkill(skill.name)}
                        >
                          <Checkbox
                            id={`skill-${skill.name}`}
                            checked={selectedSkills.includes(skill.name)}
                            onCheckedChange={() => toggleSkill(skill.name)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1"
                          />
                          <div className="space-y-1">
                            <label
                              htmlFor={`skill-${skill.name}`}
                              className="text-sm font-medium leading-none cursor-pointer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {skill.name}
                            </label>
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {skill.description}
                            </p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="col-span-2 text-center py-8 text-muted-foreground">
                        No skills found matching your search.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {agentToEdit ? 'Save Changes' : 'Create Agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
