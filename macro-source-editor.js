(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.K380MacroSourceEditor = api;
    if (root.window && root.window !== root) root.window.K380MacroSourceEditor = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const INDENT = '    ';
  const KEYWORD_PATTERN = /^(?:随机等待|释放全部|重置计时器|循环次数|循环时长|按下|弹起|点击|等待|如果|定义|调用)(?=\s|$)/;

  function leadingIndent(line) {
    return (line.match(/^ */) || [''])[0];
  }

  function continuationIndent(line) {
    const indent = leadingIndent(line);
    return line.trimEnd().endsWith(':') ? indent + INDENT : indent;
  }

  function buildInstructionSnippet(spec, indent) {
    const parent = indent + spec.text;
    if (spec.block) {
      return {
        text: `${parent}\n${indent}${INDENT}`,
        selection: null,
        cursor: parent.length + 1 + indent.length + INDENT.length
      };
    }
    const parameter = spec.selectText || '';
    const start = parameter ? parent.indexOf(parameter) : -1;
    return {
      text: parent,
      selection: start >= 0 ? {from: start, to: start + parameter.length} : null,
      cursor: parent.length
    };
  }

  function planRecordedLineInsertion(source, anchor, text) {
    const lines = source.split('\n');
    const lineText = lines[anchor.line];
    const replaceEmpty = anchor.replaceEmpty && lineText.trim() === '';
    const from = replaceEmpty
      ? {line: anchor.line, ch: 0}
      : {line: anchor.line, ch: lineText.length};
    const to = replaceEmpty
      ? {line: anchor.line, ch: lineText.length}
      : from;
    const insert = replaceEmpty
      ? `${anchor.indent}${text}`
      : `\n${anchor.indent}${text}`;
    const lineStart = lines
      .slice(0, anchor.line)
      .reduce((length, line) => length + line.length + 1, 0);
    const start = lineStart + from.ch;
    const end = lineStart + to.ch;
    const insertedLine = replaceEmpty ? anchor.line : anchor.line + 1;
    return {
      value: source.slice(0, start) + insert + source.slice(end),
      from,
      to,
      insert,
      insertedLine,
      anchor: {line: insertedLine, indent: anchor.indent, replaceEmpty: false}
    };
  }

  function defineMacroMode(CodeMirror) {
    CodeMirror.defineMode('k380-macro', function () {
      return {
        startState() {
          return {functionStyle: null};
        },
        token(stream, state) {
          if (stream.sol()) state.functionStyle = null;
          if (stream.eatSpace()) return null;
          if (stream.peek() === '#') {
            stream.skipToEnd();
            return 'comment';
          }
          if (state.functionStyle) {
            const style = state.functionStyle;
            state.functionStyle = null;
            if (stream.match(/^[^\s():#]+/)) return style;
          }
          const keyword = stream.match(KEYWORD_PATTERN);
          if (keyword) {
            if (keyword[0] === '定义') state.functionStyle = 'def';
            if (keyword[0] === '调用') state.functionStyle = 'variable-2';
            return 'keyword';
          }
          if (stream.match(/^\d+/)) return 'number';
          if (stream.match(/^[A-Z][A-Z0-9_]*(?=\s|#|$)/)) return 'atom';
          stream.next();
          return null;
        }
      };
    });
  }

  function indentSelectionWithSpaces(cm) {
    cm.execCommand('indentMore');
  }

  function unindentSelection(cm) {
    cm.execCommand('indentLess');
  }

  function newlineAndIndent(cm) {
    const cursor = cm.getCursor();
    const beforeCursor = cm.getLine(cursor.line).slice(0, cursor.ch);
    cm.replaceSelection(`\n${continuationIndent(beforeCursor)}`, 'end', '+input');
  }

  function assertActive(editor) {
    if (editor.destroyed) throw new Error('宏源码编辑器已销毁。');
  }

  function assertLine(editor, lineIndex) {
    assertActive(editor);
    if (
      !Number.isInteger(lineIndex) ||
      lineIndex < 0 ||
      lineIndex >= editor.cm.lineCount()
    ) {
      throw new RangeError('宏源码编辑器行号无效。');
    }
  }

  function replaceLineMarker(markers, lineIndex, marker) {
    const previous = markers.get(lineIndex);
    if (previous) previous.clear();
    if (marker) markers.set(lineIndex, marker);
    else markers.delete(lineIndex);
  }

  function clearLineResultTone(cm, lineIndex) {
    cm.removeLineClass(lineIndex, 'background', 'macro-line-result-warning');
    cm.removeLineClass(lineIndex, 'background', 'macro-line-result-error');
  }

  function hasEditorResources(CodeMirror) {
    const prototype = typeof CodeMirror === 'function' && CodeMirror.prototype;
    const commands = CodeMirror && CodeMirror.commands;
    const defaults = CodeMirror && CodeMirror.defaults;
    return (
      typeof CodeMirror === 'function' &&
      typeof CodeMirror.defineMode === 'function' &&
      prototype &&
      typeof prototype.openDialog === 'function' &&
      typeof prototype.getSearchCursor === 'function' &&
      typeof prototype.foldCode === 'function' &&
      commands &&
      typeof commands.find === 'function' &&
      typeof commands.toggleFold === 'function' &&
      defaults &&
      Object.prototype.hasOwnProperty.call(defaults, 'foldOptions') &&
      Object.prototype.hasOwnProperty.call(defaults, 'foldGutter') &&
      Object.prototype.hasOwnProperty.call(defaults, 'styleActiveLine') &&
      CodeMirror.fold &&
      typeof CodeMirror.fold.indent === 'function'
    );
  }

  class MacroSourceEditor {
    constructor(host, cm, onChange) {
      this.host = host;
      this.cm = cm;
      this.onChange = onChange;
      this.destroyed = false;
      this.lineResults = new Map();
      this.handleChange = () => {
        this.clearLineResults();
        this.onChange();
      };
      this.cm.on('change', this.handleChange);
    }

    getValue() {
      assertActive(this);
      return this.cm.getValue();
    }

    clear() {
      assertActive(this);
      this.cm.setValue('');
    }

    focus() {
      assertActive(this);
      this.cm.focus();
    }

    insertInstruction(spec) {
      assertActive(this);
      const line = this.cm.getCursor('to').line;
      assertLine(this, line);
      const lineText = this.cm.getLine(line);
      const indent = leadingIndent(lineText);
      const snippet = buildInstructionSnippet(spec, indent);
      const replaceEmpty = lineText.trim() === '';
      const from = replaceEmpty ? {line, ch: 0} : {line, ch: lineText.length};
      const to = replaceEmpty ? {line, ch: lineText.length} : from;
      const inserted = replaceEmpty ? snippet.text : `\n${snippet.text}`;
      const base = this.cm.indexFromPos(from) + (replaceEmpty ? 0 : 1);
      this.cm.replaceRange(inserted, from, to, '+input');
      if (snippet.selection) {
        this.cm.setSelection(
          this.cm.posFromIndex(base + snippet.selection.from),
          this.cm.posFromIndex(base + snippet.selection.to)
        );
      } else {
        this.cm.setCursor(this.cm.posFromIndex(base + snippet.cursor));
      }
      this.cm.focus();
    }

    createRecordingAnchor() {
      assertActive(this);
      const line = this.cm.getCursor('to').line;
      assertLine(this, line);
      const lineText = this.cm.getLine(line);
      return {
        line,
        indent: leadingIndent(lineText),
        replaceEmpty: lineText.trim() === ''
      };
    }

    appendRecordedLine(anchor, text) {
      assertLine(this, anchor && anchor.line);
      const plan = planRecordedLineInsertion(this.cm.getValue(), anchor, text);
      this.cm.replaceRange(plan.insert, plan.from, plan.to, '+record');
      if (typeof this.cm.changeGeneration === 'function') {
        this.cm.changeGeneration(true);
      }
      return {
        insertedLine: plan.insertedLine,
        anchor: plan.anchor
      };
    }

    clearLineResults() {
      assertActive(this);
      for (const lineIndex of Array.from(this.lineResults.keys())) {
        replaceLineMarker(this.lineResults, lineIndex, null);
      }
      for (let lineIndex = 0; lineIndex < this.cm.lineCount(); lineIndex += 1) {
        clearLineResultTone(this.cm, lineIndex);
      }
    }

    setLineResult(lineIndex, text, tone) {
      assertLine(this, lineIndex);
      if (!['', 'success', 'warning', 'error'].includes(tone)) {
        throw new RangeError('宏源码编辑器结果类型无效。');
      }
      replaceLineMarker(this.lineResults, lineIndex, null);
      clearLineResultTone(this.cm, lineIndex);

      const document = this.host.ownerDocument || root.document;
      if (!document || typeof document.createElement !== 'function') {
        throw new Error('宏源码编辑器结果组件创建失败。');
      }

      const label = String(text);
      const widget = document.createElement('span');
      widget.className = `macro-line-result-widget${tone ? ` ${tone}` : ''}`;
      widget.textContent = label;
      widget.title = label;
      widget.contentEditable = 'false';
      widget.setAttribute('aria-label', label);
      const marker = this.cm.setBookmark(
        {line: lineIndex, ch: this.cm.getLine(lineIndex).length},
        {widget}
      );
      replaceLineMarker(this.lineResults, lineIndex, marker);
      if (tone === 'warning' || tone === 'error') {
        this.cm.addLineClass(
          lineIndex,
          'background',
          `macro-line-result-${tone}`
        );
      }
    }

    destroy() {
      if (this.destroyed) return;
      this.cm.off('change', this.handleChange);
      this.clearLineResults();
      this.host.textContent = '';
      this.destroyed = true;
    }
  }

  function create(host, options) {
    if (arguments.length === 0) throw new Error('宏源码编辑器尚未初始化。');
    if (!host || typeof host !== 'object') {
      throw new TypeError('宏源码编辑器容器无效。');
    }
    const CodeMirror = root.CodeMirror;
    if (!hasEditorResources(CodeMirror)) {
      throw new Error('编辑器资源加载失败。');
    }
    if (!options || typeof options.onChange !== 'function') {
      throw new TypeError('宏源码编辑器 onChange 回调无效。');
    }

    defineMacroMode(CodeMirror);
    const cm = CodeMirror(host, {
      value: typeof options.value === 'string' ? options.value : '',
      mode: 'k380-macro',
      lineNumbers: true,
      lineWrapping: false,
      styleActiveLine: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      foldGutter: true,
      foldOptions: {rangeFinder: CodeMirror.fold.indent},
      extraKeys: {
        Tab: indentSelectionWithSpaces,
        'Shift-Tab': unindentSelection,
        Enter: newlineAndIndent,
        'Ctrl-Y': 'redo'
      }
    });
    return new MacroSourceEditor(host, cm, options.onChange);
  }

  const testing = Object.freeze({planRecordedLineInsertion, replaceLineMarker});
  return {continuationIndent, buildInstructionSnippet, testing, create};
});
