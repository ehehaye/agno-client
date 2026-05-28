import { createContext, useContext } from 'react';
import type { ChatMessage } from '@rodrigocoliveira/agno-types';
import type { FilePreviewFile } from '../../components/file-preview-card';
import type { LightboxImage } from '../../components/image-lightbox';
import type {
  AgnoMessageClassNames,
  AgnoMessageActions,
  AgnoMessageAvatars,
} from '../../types';
import type { RenderTool } from '../agno-chat/render-tool';

export interface AgnoMessageContextValue {
  message: ChatMessage;
  isLastAssistantMessage: boolean;
  /**
   * True when this message is the one currently being streamed by the agent.
   * The footer uses this to hide action buttons (copy/like/etc.) on incomplete
   * content. Set by `<AgnoChat.Messages>` (chat-context aware); defaults to
   * false when `<AgnoMessage>` is used standalone outside `<AgnoChat>`.
   */
  isStreamingThisMessage: boolean;
  classNames?: AgnoMessageClassNames;
  actions?: AgnoMessageActions;
  avatars?: AgnoMessageAvatars;
  formatTimestamp?: (date: Date) => string;
  showFilePreview: boolean;
  showImageLightbox: boolean;
  openImageLightbox: (images: LightboxImage[], index: number) => void;
  openFilePreview: (file: FilePreviewFile) => void;
  renderTool?: RenderTool;
}

export const AgnoMessageContext = createContext<AgnoMessageContextValue | null>(null);

export function useAgnoMessageContext(): AgnoMessageContextValue {
  const ctx = useContext(AgnoMessageContext);
  if (!ctx) {
    throw new Error(
      'useAgnoMessageContext must be used within an <AgnoMessage> provider. ' +
        'Wrap your slots with <AgnoMessage message={...}>.',
    );
  }
  return ctx;
}
