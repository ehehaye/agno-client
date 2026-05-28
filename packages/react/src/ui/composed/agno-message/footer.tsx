import { AlertCircle } from 'lucide-react';
import { SmartTimestamp } from '../../components/smart-timestamp';
import { formatSmartTimestamp } from '../../lib/format-timestamp';
import { cn } from '../../lib/cn';
import { useAgnoMessageContext } from './context';

export interface AgnoMessageFooterProps {
  /** Show timestamp (default: true) */
  showTimestamp?: boolean;
}

export function AgnoMessageFooter({ showTimestamp = true }: AgnoMessageFooterProps = {}) {
  const { message, classNames, actions, isLastAssistantMessage, isStreamingThisMessage, formatTimestamp } =
    useAgnoMessageContext();
  const hasError = message.streamingError;
  const isCustomTimestamp = !!formatTimestamp;
  const resolvedFormatTimestamp = formatTimestamp ?? formatSmartTimestamp;

  // The footer (actions + timestamp + error) behaves as a single unit:
  //  - Hidden entirely while the agent is still streaming this message.
  //  - `actions.visibility` controls the whole footer's reveal behavior,
  //    so the timestamp follows the same rule as the action buttons.
  if (isStreamingThisMessage) return null;

  const hasActions = !!actions?.assistant;
  const visibility = actions?.visibility ?? 'visible';

  // `last-assistant`: only render the footer on the latest assistant message.
  if (hasActions && visibility === 'last-assistant' && !isLastAssistantMessage) {
    return null;
  }

  if (!hasActions && !showTimestamp && !hasError) return null;

  // `hover` / `hover-last-visible`: fade the whole footer in on hover.
  // Only applies when actions are configured with a hover-based visibility —
  // a bare timestamp (no actions) stays always visible.
  const useHover =
    hasActions &&
    (visibility === 'hover' ||
      (visibility === 'hover-last-visible' && !isLastAssistantMessage));

  return (
    <div
      className={cn(
        'flex items-center gap-2 pt-1 transition-opacity',
        useHover && 'opacity-0 group-hover/message:opacity-100',
      )}
    >
      {hasActions && (
        <div className={cn('flex items-center gap-1', classNames?.assistant?.actions)}>
          {actions!.assistant!(message)}
        </div>
      )}
      {hasError && (
        <span className="flex items-center gap-1 text-[11px] text-destructive">
          <AlertCircle className="h-3 w-3" />
          Error
        </span>
      )}
      {showTimestamp && (
        <SmartTimestamp
          date={new Date(message.created_at * 1000)}
          formatShort={isCustomTimestamp ? resolvedFormatTimestamp : undefined}
          className="text-[11px] text-muted-foreground"
        />
      )}
    </div>
  );
}
