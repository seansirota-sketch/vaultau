# Question Content Blocks

Questions can include structured content blocks in an ordered sequence,
alongside the existing plain-text question body and sub-questions. In the
admin preview, use the buttons on a question card to add:

- Text paragraphs, which support the existing MathJax syntax.
- Code blocks, with an optional language label. Code is always displayed
  left-to-right and preserves whitespace.
- Bulleted or numbered lists.
- Tables, with editable headers, rows, and columns.

The editor persists blocks in the question's `blocks` field:

```json
{
  "type": "table",
  "headers": ["מאפיין", "ערך"],
  "rows": [["גודל בלוק", "64 בתים"]]
}
```

Existing questions without `blocks` continue to render from their `text`
field, so no migration is required.

When a question with existing text receives its first content block, its text
is converted into the first text block automatically. Use the “הוסף כאן”
controls between blocks to insert text, tables, code, or lists in the required
position. The arrow controls move a block up or down.
