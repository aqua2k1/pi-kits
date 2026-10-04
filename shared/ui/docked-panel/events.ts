/** Emitted by extension adapters only; shared UI never imports ExtensionAPI. */
export const DOCKED_PANEL_OPENED = "workflow:ui:opened";
export const DOCKED_PANEL_CLOSED = "workflow:ui:closed";

export type DockedPanelCloseStatus =
  | "completed"
  | "cancelled"
  | "aborted"
  | "error";

export interface DockedPanelOpenedEvent {
  panelId: string;
  instanceId: string;
}

export interface DockedPanelClosedEvent extends DockedPanelOpenedEvent {
  status: DockedPanelCloseStatus;
}

export interface DockedPanelLifecycle {
  /** Component created in custom's factory; NOT a post-mount/paint acknowledgment. */
  onOpen?: () => void;
  /** Once after host settlement/cleanup; failure rejects only without a prior error. */
  onClosed?: (status: DockedPanelCloseStatus) => void;
}
