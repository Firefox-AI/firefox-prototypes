import {
  Editor,
  StarterKit,
  Link,
  Placeholder,
} from "chrome://browser/content/smartwindow/tiptap-bundle.js";

console.log(Editor, StarterKit, Link, Placeholder);

export default {
  attachToElement(element) {
    // Create editor instance
    const editor = new Editor({
      element,
      extensions: [
        StarterKit,
        Link.configure({
          openOnClick: false,
        }),
        Placeholder.configure({
          placeholder: "Start typing...",
        }),
      ],
      content:
        "<p>Hello! This is a Tiptap editor loaded from a standalone ESM bundle without npm!</p>",
      onUpdate: ({ editor }) => {
        console.log("Editor content:", editor.getHTML());
      },
    });
    return editor;
  },
};
