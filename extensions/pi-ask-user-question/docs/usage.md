# 使用

## ask_user_question

在 Pi 交互界面让模型发起问卷：

```text
请使用 ask_user_question 询问我选择哪个方案，提供“<方案甲>”和“<方案乙>”。
```

模型调用工具的参数示例：

```json
{
  "questions": [
    {
      "question": "<请选择方案>",
      "multiSelect": false,
      "options": [
        { "label": "<方案甲>", "description": "<方案甲说明>" },
        { "label": "<方案乙>" }
      ]
    }
  ]
}
```

| 参数 | 类型与要求 |
|---|---|
| `questions` | 问题数组，至少一题 |
| `questions[].question` | 问题正文，非空白字符串 |
| `questions[].options` | 选项数组，至少一项；工具自动添加自定义回答入口 |
| `questions[].options[].label` | 选项文字，非空白字符串 |
| `questions[].options[].description` | 可选字符串，说明当前选项 |
| `questions[].multiSelect` | 可选 boolean，默认 `false`；`true` 收集多选回答 |

工具由模型调用并按顺序执行；每轮对话开始前按界面可用性调整工具可见性。

### 终端交互界面（TUI）

```text
↑/↓ 选择 <方案甲> → Enter 确认 → Submit 页 → Enter 提交
```

| 操作 | 结果 |
|---|---|
| Tab / Shift+Tab | 切换问题与 Submit 审阅页，保留选项位置、勾选和自定义草稿 |
| ↑ / ↓ | 移动选项；审阅页切换 Submit、Cancel 按钮 |
| Space | 多选题切换当前选项的勾选；自定义输入中输入空格 |
| Enter | 确认当前题并前进；审阅页执行当前按钮 |
| PgUp / PgDn | 在审阅页浏览问题及已确认答案 |
| Shift+↑ / Shift+↓ | 滚动长题目或当前选项说明 |
| ← / → | 在自定义回答中移动光标 |
| Esc / Ctrl+C | 取消问卷，保留已确认答案 |

选择 Custom answer 行后输入非空白的单行回答；该回答替代本题的勾选回答。多选题至少勾选一项后才能确认。

修改草稿或选项后按 Enter 才更新已确认答案；最后一题确认后进入审阅页，全部问题确认后才能 Submit。Cancel 按钮随时结束问卷。

全屏终端模式下可点击标签页和审阅按钮，滚轮滚动上方会话记录；常规终端模式使用键盘。共享面板结束后恢复编辑器草稿和焦点，布局细节见[共享 UI](../../../shared/docs/ui.md)。

### 远程调用界面（RPC）

RPC 按问题顺序显示选择框或输入框，回答完最后一题即返回结果。

```text
1,2
text: <自定义文字>
```

单选题选择选项或 Type something. 自定义入口；多选题输入从 1 开始的选项编号（逗号或空格分隔）或自定义文字，纯数字自定义文字使用 `text:` 前缀。空白输入与无效数字选择会重新询问；关闭对话框取消问卷。

### 结果

结构化结果同时放入 `details` 和 `structuredContent`：

| 字段 | 含义 |
|---|---|
| `answers` | 按问题顺序排列的已确认答案数组 |
| `cancelled` | 用户取消时为 `true`，提交时为 `false` |
| `answers[].questionIndex`、`answers[].question` | 从零开始的问题索引与原始问题正文 |
| `answers[].kind` | `option` 为单选、`custom` 为自定义、`multi` 为多选 |
| `answers[].optionIndex` | 单选选项索引，从零开始 |
| `answers[].optionIndices` | 多选选项索引，从零开始、去重并升序排列 |
| `answers[].selected` | 多选标签，按选项顺序保留重复标签 |
| `answers[].answer` | 回答文字；多选标签以逗号和空格连接 |

取消时工具文本为 `User cancelled`，结构化结果保留已确认答案；未确认草稿不计入答案。重复标签通过选项索引区分。

终端问卷开始时发送等待回答通知，开关见[配置](configuration.md)；RPC 使用问卷对话框。
