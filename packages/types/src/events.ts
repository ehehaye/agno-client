/**
 * Events emitted during an Agno agent run
 */
export enum RunEvent {
  RunStarted = 'RunStarted',
  RunContent = 'RunContent',
  RunCompleted = 'RunCompleted',
  RunError = 'RunError',
  RunOutput = 'RunOutput',
  UpdatingMemory = 'UpdatingMemory',
  ToolCallStarted = 'ToolCallStarted',
  ToolCallCompleted = 'ToolCallCompleted',
  MemoryUpdateStarted = 'MemoryUpdateStarted',
  MemoryUpdateCompleted = 'MemoryUpdateCompleted',
  ReasoningStarted = 'ReasoningStarted',
  ReasoningStep = 'ReasoningStep',
  ReasoningCompleted = 'ReasoningCompleted',
  RunCancelled = 'RunCancelled',
  RunPaused = 'RunPaused',
  RunContinued = 'RunContinued',
  // Team Events
  TeamRunStarted = 'TeamRunStarted',
  TeamRunContent = 'TeamRunContent',
  TeamRunCompleted = 'TeamRunCompleted',
  TeamRunError = 'TeamRunError',
  TeamRunCancelled = 'TeamRunCancelled',
  TeamToolCallStarted = 'TeamToolCallStarted',
  TeamToolCallCompleted = 'TeamToolCallCompleted',
  TeamReasoningStarted = 'TeamReasoningStarted',
  TeamReasoningStep = 'TeamReasoningStep',
  TeamReasoningCompleted = 'TeamReasoningCompleted',
  TeamMemoryUpdateStarted = 'TeamMemoryUpdateStarted',
  TeamMemoryUpdateCompleted = 'TeamMemoryUpdateCompleted',
  // Custom Events (user-defined events from tools)
  CustomEvent = 'CustomEvent',
}

/**
 * Events emitted by the AgnoClient
 */
export type ClientEvent =
  | 'message:update'
  | 'message:complete'
  | 'message:refreshed'
  | 'message:error'
  | 'session:loaded'
  | 'session:created'
  | 'stream:start'
  | 'stream:end'
  | 'state:change'
  | 'config:change'
  | 'run:paused'
  | 'run:continued'
  | 'run:cancelled'   // Emitted when run is cancelled by user
  // Generative UI events
  | 'ui:update'       // Emitted when UI component data updates (streaming)
  | 'ui:complete'     // Emitted when UI component is finalized
  | 'ui:render'      // Emitted when a new UI component should be rendered
  | 'custom:event'
  // Team member events (internal agent activity within teams)
  | 'member:event'    // Emitted for any internal team member event (when emitMemberEvents is true)
  | 'member:started'  // Emitted when a team member starts processing
  | 'member:content'  // Emitted when a team member produces content
  | 'member:completed' // Emitted when a team member completes
  | 'member:error'    // Emitted when a team member encounters an error
  // Background execution / resume lifecycle
  | 'run:resume:start'   // resumeRun call started
  | 'run:resume:meta'    // catch_up / replay / subscribed meta event from /resume
  | 'run:resume:end'     // resume stream completed normally
  | 'run:resume:error';  // /resume failed (run not found, buffer expired, network)
