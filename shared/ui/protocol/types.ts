export interface UIOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface UIFieldBase {
  kind: "field";
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string;
}

export type UIField =
  | (UIFieldBase & {
      type: "text";
      value: string;
      placeholder?: string;
    })
  | (UIFieldBase & {
      type: "single";
      value: string | null;
      options: UIOption[];
      filterable?: boolean;
    })
  | (UIFieldBase & {
      type: "multiple";
      value: string[];
      options: UIOption[];
      filterable?: boolean;
    });

export type UIContentStatus =
  | "info"
  | "running"
  | "success"
  | "warning"
  | "error"
  | "cancelled"
  | "stale"
  | "truncated";

export type UINode =
  | {
      kind: "group";
      id: string;
      title?: string;
      description?: string;
      children: UINode[];
    }
  | {
      kind: "content";
      id: string;
      format: "text" | "markdown" | "json";
      body: string;
      summary?: string;
      status?: UIContentStatus;
    }
  | UIField
  | {
      kind: "action";
      id: string;
      label: string;
      disabled?: boolean;
      emphasis?: "default" | "primary" | "destructive";
    };

/** A complete snapshot. Revision ordering is enforced by the future session. */
export interface UIView {
  id: string;
  revision: number;
  root: UINode;
}

/** Semantic events, not keyboard/mouse events or remote transport envelopes. */
export type UIEvent = {
  viewId: string;
  revision: number;
} & (
  | { type: "change"; nodeId: string; value: string | null | string[] }
  | { type: "invoke"; nodeId: string }
  | { type: "dismiss" }
);
