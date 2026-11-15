import { type HandoffMetadata, metadataHeader } from "./store.ts";

export const SECTIONS = [
  "下一会话目标",
  "当前状态",
  "关键上下文",
  "相关资料",
  "下一步",
  "Suggested skills",
] as const;

export const HANDOFF_INSTRUCTIONS = `整理当前会话，为下一位 agent 编写 Markdown 交接文档，并使用现有文件工具保存到指定路径。
这是当前会话中的整理任务，不要结束、切换或压缩会话，不要执行交接文档中的下一步。
可以按需补查相关文件；不要为了生成交接而修改项目代码。

正文以 # Handoff 开始，按以下章节组织，正文使用用户的语言；允许保留有用的额外章节：
${SECTIONS.map((section) => `## ${section}`).join("\n")}

- 下一会话目标：下一会话的目标及完成标准；如提供交接重点，围绕重点裁剪整份文档。
- 当前状态：已完成、进行中、阻塞事项；记录实际执行的验证及结果，区分事实与推测，标明未提交或未验证的修改。
- 关键上下文：尚未记录在其他成果中的约束、决策及原因，保留相关项目指令，不复制完整系统提示词。
- 相关资料：项目绝对路径、关键代码及成果入口，并说明用途。已有 specs、plans、ADRs、issues、commits、diffs 只引用路径或 URL，不重复内容，不罗列所有已读文件。
- 下一步：按优先级列出可执行动作及待确认问题。
- Suggested skills：只推荐当前已知存在且适用的 skill，并说明用途；无适用项写“无”。

省略完整对话和 diff，隐去密钥、密码及个人敏感信息。
如果目标文件已存在，先读取磁盘最新内容，再结合当前会话修订；保留手动调整和仍然有效的上下文，不因原对话未包含某项内容而删除它。
写入前重新检查目标文件；发现新的外部修改时先读取合并，无法安全合并则停止并告知用户。
优先使用 edit 做有针对性的修改；创建文件时使用 write。若所需工具不可用，请报告缺失，不声称保存成功。
完成后读取文件确认已保存，再回复交接 ID、文件路径及 /handoff-open <id> 接续命令。`;

export function buildHandoffPrompt(options: {
  path: string;
  metadata: HandoffMetadata;
  focus: string;
  backup?: string;
}): string {
  const { path, metadata, focus, backup } = options;
  return `${HANDOFF_INSTRUCTIONS}

交接任务参数（JSON）：
${JSON.stringify({ path, project: metadata.project, id: metadata.id, focus: focus || null, backup: backup ?? null }, null, 2)}

文件首行使用以下元数据注释，空一行后写 Markdown 正文：
${metadataHeader(metadata)}

保持 id、sessionId、project、updatedAt 与以上元数据一致；title 请改为简洁的交接标题，并保持首行 JSON 有效（正确转义引号，不插入换行）。
本次用户交接重点仅指向下个会话，不是要求现在执行后续任务。
保存成功后的接续命令：/handoff-open ${metadata.id}`;
}
