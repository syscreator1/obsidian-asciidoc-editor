// CodeMirror 5 の AsciiDoc 定義を移植したもの
export const asciidocMode = {
    name: "asciidoc",
    startState: function() {
        return {
            list: false,
            head: false
        };
    },
    token: function(stream: any, state: any) {
        if (stream.sol()) {
            state.list = false;
            state.head = false;
        }
        if (stream.eatSpace()) return null;
        
        const ch = stream.next();
        
        // 見出し (=)
        if (ch === '=' && stream.sol()) {
            stream.skipToEnd();
            return "header";
        }
        // リスト (*, -, .)
        if ((ch === '*' || ch === '-' || ch === '.') && stream.eatSpace()) {
            return "list";
        }
        // 太字 (*bold*)
        if (ch === '*') {
            while (stream.next() && stream.current().slice(-1) !== '*') {}
            return "strong";
        }
        
        return null;
    }
};