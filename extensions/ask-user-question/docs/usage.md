## User questions (MVP)

`ask_user_question` asks single-choice or multi-select questions in a fixed lower-half terminal
panel. Editor-style rules use Pi's active theme; the upper half stays visible.
The non-overlay panel temporarily replaces Pi's editor. Pi lays out the transcript
above the dock and keeps ownership of the surrounding footer, notifications and
widgets; small terminals may shrink or clip these regions. Closing restores the
editor, its draft, and focus.
Every row is filled to the panel width so underlying content cannot show through.
Short questionnaires leave blank space; input and footer stay at the bottom.
Long option lists scroll.
Use Left/Right or Tab/Shift+Tab to switch questions and revisit answers. Each
question keeps its selected option and custom-answer draft. Confirm answers with
Enter, then review from the Submit tab. It has separate Submit and Cancel
buttons: Up/Down chooses a button, Enter activates it, and fullscreen mouse clicks
activate buttons directly. PgUp/PgDn browses the reviewed answers independently
of button focus. All questions must be answered before Submit succeeds; Cancel
is always available. Esc cancels; earlier answers remain in `details` but are not a
completed submission. Cancellation returns only `User cancelled` in the tool text;
the structured `details` still carries `cancelled: true` and any earlier answers.

In Pi's fullscreen terminal mode, tabs can also be clicked with the mouse. Regular
terminal mode leaves mouse input to the terminal, so use keyboard navigation there.
Enable fullscreen using Pi's `tuiMode: "fullscreen"` setting if needed; this is a Pi
setting, not a `pi-kits.json` option. RPC uses native select/input dialogs sequentially
and does not support tabs or review. Shift+Up/Down scroll long question details;
The panel owns keyboard input while open. While typing a
custom answer, use Ctrl+B/F or Home/End to move the cursor.

There are no upper limits on question counts, option counts, or text lengths; each
call needs at least one question and each question at least one option. A custom
answer row is appended automatically. Blank custom answers cannot be confirmed.

Set `multiSelect: true` on a question to show checkboxes. Space toggles the focused
option, while Enter confirms all checked options and advances. At least one option
must be checked. Checks survive switching tabs and can be revised. A custom answer
replaces the checkbox answer rather than combining with it; Space types normally
inside the custom-answer editor. Single-select remains the default.

RPC multi-select uses a native input dialog: enter option numbers such as `1,3`
or a custom answer. Invalid numeric selections and blank input are retried.
Use `text: 123` to submit a numeric custom answer rather than option numbers.

```json
{
  "questions": [
    {
      "question": "Which cache should we use?",
      "options": [
        { "label": "Memory (Recommended)", "description": "No infrastructure" },
        { "label": "Redis", "description": "Shared across instances" }
      ]
    }
  ]
}
```

The tool declares documented input and output JSON schemas. Structured results
are returned in `structuredContent` as well as `details`; successful tool text
still includes the answers, and cancellation text remains `User cancelled`.

Results include `answers` and `cancelled`; each answer includes `questionIndex`,
`question`, `kind` (`option`, `custom`, or `multi`), and `answer`. Option answers
also include `optionIndex`. Multi-select answers include `selected` labels and
zero-based `optionIndices`, so duplicate labels are unambiguous. Non-interactive
runs hide the tool. Execution is sequential and respects abort signals. This MVP
has no previews or notes.

Disable other extensions registering `ask_user_question` (including
`rpiv-ask-user-question`) before loading this entry. Set
`askUserQuestion.enabled: false` to disable it independently.

### Question lifecycle hooks

The question extension emits hooks through `pi.events`:

- `workflow:ask-user-question:start`: immediately before dialog interaction.
- `workflow:ask-user-question:end`: after answering, cancelling, aborting, or
  a dialog error.

Both payloads include `toolCallId`, `mode`, and `questionCount`. The end hook
also includes `status` (`answered`, `cancelled`, `aborted`, or `error`);
answered/cancelled events include `result`. Calls without UI or already aborted
before interaction emit neither hook. Constants and payload types live in
`../events.ts`.

The question extension itself sends a best-effort desktop notification,
`Pi: Waiting for your answer.`, when TUI interaction begins. It uses the shared
notification transport, requires no notify extension to be loaded, and respects
`notify.enabled`. RPC interactions emit hooks but do not send desktop
notifications. Closing the questionnaire emits the end hook without another
desktop notification.

TUI-only panel notifications are separate from tool start/end:

- `workflow:ui:opened`: the shared session created the component inside
  `ui.custom`'s factory, before returning it to Pi. Pi has no post-mount callback:
  this is an opening notification, **not proof of mounting or first paint**.
- `workflow:ui:closed`: once the host promise settles and the abort listener and
  component resources are cleaned up. Its `status` is `completed`, `cancelled`,
  `aborted`, or `error` (`completed` corresponds to tool status `answered`).

Both include `panelId: "ask-user-question"` and `instanceId` (the tool call ID).
The order for an opened TUI interaction is tool start, panel opened, panel closed,
then tool end. No panel events are emitted for RPC, a host failure before factory
creation, or an abort observed before opening. An opened interaction gets one
closed notification even on errors. Constants/types are exported from
`@pi-kits/shared/ui/docked-panel`. Entry-point callbacks emit through `pi.events`;
the shared layer does not subscribe to Pi events. Opened-callback failures still
attempt closed after cleanup. The original interaction/factory/cancellation error
wins over disposal and closed-callback errors; disposal errors reject only when
there is no original failure, and closed-callback errors only when neither has
failed. If abort cancellation throws, the session retains that error and calls
Pi's factory completion callback to settle/restore the host before rejecting,
not a competing rejection that could leave the panel mounted. Closed status is
`aborted` whenever the signal is aborted, including cancellation/disposal failures;
the rejection still preserves the original error identity.
