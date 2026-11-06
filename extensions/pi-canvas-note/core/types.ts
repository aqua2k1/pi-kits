import type { Page } from "./model.ts";

export type RenderErrorReport = {
  version: number;
  blockId: string;
  message: string;
};

export type Feedback = {
  requestId: string;
  version: number;
  reply: string;
  blocks: { pageId: string; pageTitle: string; block: unknown }[];
  /** Absent in legacy snapshots; independent of the selected blocks. */
  pageIds?: string[];
  pages?: Page[];
};
