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
};
