import {
  Editor,
  StarterKit,
  Link,
  Placeholder,
} from "chrome://browser/content/smartwindow/tiptap-bundle.js";

console.log(Editor, StarterKit, Link, Placeholder);

export function attachToElement(element, options = {}) {
  const { onKeyDown, onUpdate } = options;

  // Create editor instance
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: false,
      }),
      Placeholder.configure({
        placeholder: "Ask, search, or type a URL...",
      }),
    ],
    content: "",
    onUpdate: ({ editor }) => {
      console.log("Editor content:", editor.getHTML());
      if (onUpdate) {
        onUpdate(editor.getText());
      }
    },
    editorProps: {
      handleKeyDown(view, event) {
        // Call the external key handler if provided
        if (onKeyDown) {
          onKeyDown(event);
        }

        // Prevent default Tiptap behavior for certain keys
        const keysToPrevent = ["Enter", "ArrowUp", "ArrowDown", "Escape"];

        if (keysToPrevent.includes(event.key)) {
          // For Enter, only prevent if Shift is not pressed (allow Shift+Enter for newlines)
          if (event.key === "Enter" && event.shiftKey) {
            return false; // Let Tiptap handle Shift+Enter for new lines
          }
          // Prevent Tiptap's default handling
          return true;
        }

        return false;
      },
    },
  });

  // Return an object with the editor and helper functions
  return {
    editor,

    // Helper functions
    focus() {
      editor.commands.focus("end");
    },

    getText() {
      return editor.getText();
    },

    setContent(content) {
      editor.commands.setContent(content);
    },

    clear() {
      editor.commands.setContent("");
      // Refocus after clearing
      editor.commands.focus("end");
    },

    setEditable(editable) {
      editor.setEditable(editable);
    },

    destroy() {
      editor.destroy();
    },
  };
}
