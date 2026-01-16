// Ported implementation of the AsciiDoc mode from CodeMirror 5
export const asciidocMode = {
    name: "asciidoc",

    // Create the initial parser state
    startState: function() {
        return {
            list: false, // Whether the current line is a list item
            head: false  // Whether the current line is a heading
        };
    },

    // Tokenizer function
    token: function(stream: any, state: any) {
        // Reset state at the beginning of a line
        if (stream.sol()) {
            state.list = false;
            state.head = false;
        }

        // Skip whitespace
        if (stream.eatSpace()) return null;

        const ch = stream.next();

        // Headings (=, ==, ===, ...)
        if (ch === '=') {
            state.head = true;
            while (stream.eat('=')) {}
            return "header";
        }

        // List items (*, -, .)
        if ((ch === '*' || ch === '-' || ch === '.') && stream.eatSpace()) {
            return "list";
        }

        // Bold text (*bold*)
        if (ch === '*') {
            while (stream.next() && stream.current().slice(-1) !== '*') {}
            return "strong";
        }

        return null;
    }
};
