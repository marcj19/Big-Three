/**
 * Actions the views call on each other. They are filled in by app.ts, which keeps the views free of import cycles.
 */
export const ctx = {
  refreshProviders: async (): Promise<void> => {},
  refreshConnections: async (): Promise<void> => {},
  refreshConversations: async (): Promise<void> => {},
  openConversation: async (_id: string, _keepScroll?: boolean): Promise<void> => {},
  newConversation: async (): Promise<boolean> => false,
  send: async (): Promise<void> => {},
  renderSidebar: (): void => {},
  renderTopbar: (): void => {},
  renderMessages: (): void => {},
  renderComposer: (_animate?: boolean): void => {},
  focusComposer: (): void => {},
  setPrompt: (_text: string): void => {},
};
