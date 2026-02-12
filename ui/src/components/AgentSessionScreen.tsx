import React, { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowLeft, Send, Square, Play, CheckCircle2, ListTodo, Plus, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SkilledAgent } from '../lib/types'

const remarkPlugins = [remarkGfm]

const markdownComponents: Components = {
  a: ({ children, href, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
}

interface AgentSessionScreenProps {
  projectName: string
  agent: SkilledAgent
  onBack: () => void
}

interface Task {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  isStreaming?: boolean
}

export function AgentSessionScreen({ projectName, agent, onBack }: AgentSessionScreenProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [newTaskInput, setNewTaskInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isAgentRunning, setIsAgentRunning] = useState(false)
  const [isInitializing, setIsInitializing] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [, setConversationId] = useState<number | undefined>(undefined)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pingIntervalRef = useRef<number | null>(null)

  // Connect WebSocket on mount
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/api/skilled-agents/ws/${agent.id}/${encodeURIComponent(projectName)}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[AgentSession] WebSocket connected')
      // Send start message to initialize the session
      ws.send(JSON.stringify({ type: 'start', conversation_id: null }))

      // Keep-alive ping
      pingIntervalRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30000)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case 'conversation_created':
            setConversationId(data.conversation_id)
            break

          case 'text':
            // First text token means we're no longer "thinking"
            setIsSending(false)
            setChatMessages(prev => {
              const lastMsg = prev[prev.length - 1]
              if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                return [
                  ...prev.slice(0, -1),
                  { ...lastMsg, content: lastMsg.content + data.content }
                ]
              } else {
                return [...prev, {
                  id: Date.now().toString(),
                  role: 'assistant',
                  content: data.content,
                  timestamp: new Date(),
                  isStreaming: true
                }]
              }
            })
            break

          case 'tool_call': {
            const toolName = data.tool || 'unknown'
            let desc = `Using tool: ${toolName}`
            if (toolName === 'Read') {
              const path = data.input?.file_path || ''
              desc = `Reading file: ${path.split('/').pop() || path}`
            } else if (toolName === 'Glob') {
              desc = `Searching for files: ${data.input?.pattern || '...'}`
            } else if (toolName === 'Grep') {
              desc = `Searching for: ${data.input?.pattern || '...'}`
            }
            setChatMessages(prev => [...prev, {
              id: 'tool-' + Date.now(),
              role: 'system',
              content: desc,
              timestamp: new Date()
            }])
            break
          }

          case 'response_done':
            setIsSending(false)
            setIsInitializing(false)
            setIsAgentRunning(true)
            setChatMessages(prev => prev.map(m => ({ ...m, isStreaming: false })))
            break

          case 'error':
            setIsSending(false)
            setIsInitializing(false)
            setChatMessages(prev => [...prev, {
              id: 'error-' + Date.now(),
              role: 'system',
              content: data.content || 'An error occurred.',
              timestamp: new Date()
            }])
            break

          case 'pong':
            break

          default:
            console.log('[AgentSession] Unknown message type:', data.type)
        }
      } catch (e) {
        console.error('[AgentSession] Failed to parse WebSocket message', e)
      }
    }

    ws.onclose = () => {
      console.log('[AgentSession] WebSocket disconnected')
      setIsAgentRunning(false)
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
        pingIntervalRef.current = null
      }
    }

    ws.onerror = () => {
      console.error('[AgentSession] WebSocket error')
      setIsInitializing(false)
      setChatMessages(prev => [...prev, {
        id: 'error-' + Date.now(),
        role: 'system',
        content: 'WebSocket connection error. Please try again.',
        timestamp: new Date()
      }])
    }

    return () => {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
  }, [agent.id, projectName])

  // Scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  // Scroll to bottom when sending
  useEffect(() => {
    if (isSending) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [isSending])

  const handleAddTask = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!newTaskInput.trim()) return

    const newTask: Task = {
      id: Date.now().toString(),
      text: newTaskInput,
      status: 'pending'
    }

    setTasks(prev => [...prev, newTask])
    setNewTaskInput('')
  }

  const handleTaskStatusChange = (taskId: string, newStatus: Task['status']) => {
    setTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, status: newStatus } : t
    ))
  }

  const deleteTask = (taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId))
  }

  const handleSendMessage = useCallback((e?: React.FormEvent) => {
    e?.preventDefault()
    if (!chatInput.trim() || !isAgentRunning || isSending) return

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const userContent = chatInput
    setChatInput('')
    setIsSending(true)

    // Add user message to chat
    setChatMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'user',
      content: userContent,
      timestamp: new Date()
    }])

    // Send via WebSocket
    ws.send(JSON.stringify({ type: 'message', content: userContent }))
  }, [chatInput, isAgentRunning, isSending])

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 pb-4 border-b">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h2 className="text-xl font-bold font-display flex items-center gap-2">
              {agent.name}
              <Badge variant="outline" className="ml-2 font-normal text-xs">
                {isInitializing ? 'Initializing...' : isAgentRunning ? 'Running' : 'Ready'}
              </Badge>
            </h2>
            <p className="text-sm text-muted-foreground truncate max-w-md">
              Skills: {agent.config.skills.join(', ') || 'General'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isAgentRunning ? (
            <Button variant="destructive" size="sm" onClick={() => setIsAgentRunning(false)} disabled={isInitializing}>
              <Square className="h-4 w-4 mr-2" />
              Stop Agent
            </Button>
          ) : (
            <Button variant="default" size="sm" onClick={() => setIsAgentRunning(true)} disabled={isInitializing}>
              <Play className="h-4 w-4 mr-2" />
              Start Agent
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-0">
        {/* Left Column: Chat */}
        <div className="lg:col-span-2 flex flex-col min-h-0 bg-card rounded-lg border shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-muted/20 flex justify-between items-center">
            <h3 className="font-medium">Session Chat</h3>
            {(isInitializing || isSending) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              {chatMessages.length === 0 && !isInitializing && (
                <div className="text-center p-8 text-muted-foreground italic">
                  Waiting for agent to initialize...
                </div>
              )}
              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-4 py-3 ${msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : msg.role === 'system'
                        ? 'bg-muted text-muted-foreground text-sm font-mono'
                        : 'bg-muted/50 border'
                      }`}
                  >
                    {msg.role === 'system' ? (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    ) : (
                      <div className={`text-sm leading-relaxed chat-prose${msg.role === 'user' ? ' chat-prose-user' : ''}`}>
                        <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}
                    <span className="text-[10px] opacity-50 block mt-1 text-right">
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))}
              {isSending && (
                <div className="flex justify-start animate-in fade-in duration-300">
                  <div className="bg-muted/30 border rounded-lg px-4 py-3 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Thinking...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          <div className="p-4 border-t bg-background">
            <form onSubmit={handleSendMessage} className="flex gap-2">
              <Input
                placeholder="Type a message to the agent..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                disabled={!isAgentRunning || isInitializing || isSending}
                className="flex-1"
              />
              <Button type="submit" disabled={!isAgentRunning || isInitializing || isSending || !chatInput.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </div>

        {/* Right Column: Task List */}
        <div className="flex flex-col min-h-0 bg-card rounded-lg border shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-muted/20 flex justify-between items-center">
            <h3 className="font-medium flex items-center gap-2">
              <ListTodo className="h-4 w-4" />
              Task List
            </h3>
            <Badge variant="secondary">{tasks.length} tasks</Badge>
          </div>

          <div className="p-4 border-b bg-background">
            <form onSubmit={handleAddTask} className="flex gap-2">
              <Input
                placeholder="Add a task..."
                value={newTaskInput}
                onChange={(e) => setNewTaskInput(e.target.value)}
                className="h-9"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!newTaskInput.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </form>
          </div>

          <ScrollArea className="flex-1 p-0">
            {tasks.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                No tasks tracked yet.
              </div>
            ) : (
              <div className="divide-y">
                {tasks.map((task) => (
                  <div key={task.id} className="p-3 flex items-start gap-3 group hover:bg-muted/5">
                    <div className="mt-1">
                      {task.status === 'completed' ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500 cursor-pointer" onClick={() => handleTaskStatusChange(task.id, 'pending')} />
                      ) : (
                        <div className="h-5 w-5 rounded-full border-2 border-muted-foreground/30 cursor-pointer hover:border-primary" onClick={() => handleTaskStatusChange(task.id, 'completed')} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${task.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>
                        {task.text}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <select
                          className="text-[10px] bg-transparent border rounded px-1 py-0.5"
                          value={task.status}
                          onChange={(e) => handleTaskStatusChange(task.id, e.target.value as any)}
                        >
                          <option value="pending">Pending</option>
                          <option value="in_progress">In Progress</option>
                          <option value="completed">Completed</option>
                          <option value="cancelled">Cancelled</option>
                        </select>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteTask(task.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}
