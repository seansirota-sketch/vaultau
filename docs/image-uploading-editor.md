# Image Uploading In Question Editor

## How It Works

### Editor Flow

In the admin editor, images are added directly through the question or sub-question text area.

Supported actions:

1. Paste an image into the textarea.
2. Drag and drop an image onto the textarea.
3. Remove an image from the preview card, which removes the matching token from the text automatically.

When an image is added:

1. The image is uploaded immediately to Firebase Storage.
2. The textarea receives a short inline Markdown token.
3. The editor shows a preview card below the textarea.
4. While upload is running, the preview card shows upload progress.

Example token:

```md
![image](img:abc123)
```

### Text Format

Question text and sub-question text store image references as Markdown image syntax.

Example:

```md
חשב את הערך הבא:

![image](img:abc123)
```

The `img:abc123` reference is resolved through the `inlineImages` object saved with that question or sub-question.

## Where Images Are Saved

### Firestore

Each question or sub-question may contain:

```json
{
  "text": "Some text...\n![image](img:abc123)",
  "inlineImages": {
    "abc123": "https://firebasestorage.googleapis.com/..."
  }
}
```

### Firebase Storage

Image files are stored in Firebase Storage under paths similar to:

```text
question-images/{draftOrExamId}/...
```

Examples:

```text
question-images/draft-adminUid/q-questionId-1712500000000-image.png
question-images/examId/q-questionId/s-subId-1712500000000-image.png
```

## Rendering

On the student-facing side:

1. The renderer scans question text for Markdown image tokens.
2. If the token contains a real URL, it uses that URL directly.
3. If the token uses `img:key`, it looks up the real URL from `inlineImages`.
4. The image is rendered inline in the question body where the token appears.

## Edit And Save Behavior

### When Saving

1. Save is blocked if any image upload is still running.
2. The final `inlineImages` map is written into Firestore along with the text.
3. If an existing exam is edited and an image was removed from the text, the removed Storage file is deleted during save.

### Legacy Images

Older exams may still contain legacy fields such as:

- `imageUrl`
- `imageAlign`
- `imageStoragePath`

When such an exam is opened in edit mode:

1. The editor converts the legacy image into an inline text token.
2. The image becomes visible in the editor preview cards.
3. The admin can remove it normally by deleting the token or using the preview-card remove button.

## Troubleshooting

### Broken image appears for students but not in editor

Cause:
The question still used legacy image fields outside the text model.

Fix:
Open the exam in edit mode. The editor migrates the legacy image into inline token form automatically.

### Image preview exists but image is broken

Possible causes:

- The Firebase Storage object was deleted manually.
- The saved URL is invalid.
- Storage access is blocked by rules.

Fix:

1. Open the exam in edit mode.
2. Find the image preview card or image token.
3. Remove it.
4. Paste or drag the image again.

### Save is blocked

Cause:
At least one image upload is still in progress.

Fix:
Wait for upload preview/status to finish, then save again.

### Removed image still exists in Storage

Expected behavior:
For edited exams, removed images are deleted from Storage during save if they are no longer referenced.

If cleanup does not happen:

1. Confirm the token was actually removed from the text.
2. Save the exam again.
3. Check Storage permissions and delete access.

## Current Behavior Summary

- Paste upload is supported.
- Drag-and-drop upload is supported.
- Preview cards show uploaded and uploading images.
- Preview cards include remove buttons.
- Rich inline WYSIWYG editing is not implemented.
