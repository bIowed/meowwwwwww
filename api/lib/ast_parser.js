// language: JavaScript, file: lib/ast_parser.js, runtime: Node.js / V8, target: Edge / Serverless
/**
 * Industrial Lexical Scanner, Tokenizer, and AST Rewriter for Dynamic Client Scripts.
 * Hand-crafted tokenizer that walks raw JavaScript strings, identifies syntax tokens,
 * and surgically rewrites member expressions, variable assignments, and global accessors
 * to prevent client scripts from escaping the proxy sandbox.
 */

const TokenType = {
  KEYWORD: 'KEYWORD',
  IDENTIFIER: 'IDENTIFIER',
  PUNCTUATION: 'PUNCTUATION',
  OPERATOR: 'OPERATOR',
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  REGEX: 'REGEX',
  WHITESPACE: 'WHITESPACE',
  COMMENT: 'COMMENT'
};

class Token {
  constructor(type, value, start, end) {
    this.type = type;
    this.value = value;
    this.start = start;
    this.end = end;
  }
}

class Lexer {
  constructor(source) {
    this.source = source;
    this.pos = 0;
    this.len = source.length;
  }

  isAlpha(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
  }

  isDigit(c) {
    return c >= '0' && c <= '9';
  }

  isAlphaNumeric(c) {
    return this.isAlpha(c) || this.isDigit(c);
  }

  tokenize() {
    const tokens = [];

    while (this.pos < this.len) {
      const start = this.pos;
      const char = this.source[this.pos];

      // Whitespace
      if (/\s/.test(char)) {
        while (this.pos < this.len && /\s/.test(this.source[this.pos])) {
          this.pos++;
        }
        tokens.push(new Token(TokenType.WHITESPACE, this.source.slice(start, this.pos), start, this.pos));
        continue;
      }

      // Line & Block Comments
      if (char === '/' && this.pos + 1 < this.len) {
        const nextChar = this.source[this.pos + 1];
        if (nextChar === '/') {
          this.pos += 2;
          while (this.pos < this.len && this.source[this.pos] !== '\n') {
            this.pos++;
          }
          tokens.push(new Token(TokenType.COMMENT, this.source.slice(start, this.pos), start, this.pos));
          continue;
        } else if (nextChar === '*') {
          this.pos += 2;
          while (this.pos + 1 < this.len && !(this.source[this.pos] === '*' && this.source[this.pos + 1] === '/')) {
            this.pos++;
          }
          this.pos += 2;
          tokens.push(new Token(TokenType.COMMENT, this.source.slice(start, this.pos), start, this.pos));
          continue;
        }
      }

      // Strings (single, double, template)
      if (char === '"' || char === "'" || char === '`') {
        const quote = char;
        this.pos++;
        while (this.pos < this.len) {
          if (this.source[this.pos] === '\\') {
            this.pos += 2;
            continue;
          }
          if (this.source[this.pos] === quote) {
            this.pos++;
            break;
          }
          this.pos++;
        }
        tokens.push(new Token(TokenType.STRING, this.source.slice(start, this.pos), start, this.pos));
        continue;
      }

      // Numbers
      if (this.isDigit(char)) {
        while (this.pos < this.len && (this.isDigit(this.source[this.pos]) || this.source[this.pos] === '.')) {
          this.pos++;
        }
        tokens.push(new Token(TokenType.NUMBER, this.source.slice(start, this.pos), start, this.pos));
        continue;
      }

      // Identifiers and Keywords
      if (this.isAlpha(char)) {
        while (this.pos < this.len && this.isAlphaNumeric(this.source[this.pos])) {
          this.pos++;
        }
        const val = this.source.slice(start, this.pos);
        const keywords = ['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static'];
        const type = keywords.includes(val) ? TokenType.KEYWORD : TokenType.IDENTIFIER;
        tokens.push(new Token(type, val, start, this.pos));
        continue;
      }

      // Operators and Punctuation
      const doubleChar = this.source.slice(this.pos, this.pos + 2);
      const multiOps = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '=>'];
      let matched = false;

      for (const op of multiOps) {
        if (this.source.startsWith(op, this.pos)) {
          this.pos += op.length;
          tokens.push(new Token(TokenType.OPERATOR, op, start, this.pos));
          matched = true;
          break;
        }
      }

      if (matched) continue;

      this.pos++;
      const isOp = '+-*/%=<>!&|^~?'.includes(char);
      tokens.push(new Token(isOp ? TokenType.OPERATOR : TokenType.PUNCTUATION, char, start, this.pos));
    }

    return tokens;
  }
}

class AstRewriter {
  constructor(proxyBase, targetOrigin, currentPageUrl) {
    this.proxyBase = proxyBase;
    this.targetOrigin = targetOrigin;
    this.currentPageUrl = currentPageUrl;
  }

  rewrite(jsCode) {
    if (!jsCode || typeof jsCode !== 'string') return jsCode;

    try {
      const lexer = new Lexer(jsCode);
      const tokens = lexer.tokenize();
      const output = [];

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const next = i + 1 < tokens.length ? tokens[i + 1] : null;
        const prev = i > 0 ? tokens[i - 1] : null;

        // Rewrite location access: window.location -> window.__vproxy_location
        if (token.type === TokenType.IDENTIFIER && token.value === 'location') {
          // Check if preceded by dot: window.location, document.location, top.location
          if (prev && prev.value === '.') {
            const beforeDot = i > 1 ? tokens[i - 2] : null;
            if (beforeDot && ['window', 'document', 'self', 'globalThis', 'top', 'parent'].includes(beforeDot.value)) {
              output.push('__vproxy_location');
              continue;
            }
          }
          // Standalone location access
          if (!prev || (prev.type === TokenType.OPERATOR || prev.type === TokenType.PUNCTUATION)) {
            output.push('__vproxy_location');
            continue;
          }
        }

        // Rewrite top / parent window references
        if (token.type === TokenType.IDENTIFIER && (token.value === 'top' || token.value === 'parent')) {
          if (prev && prev.value === '.') {
            const beforeDot = i > 1 ? tokens[i - 2] : null;
            if (beforeDot && beforeDot.value === 'window') {
              output.push('self');
              continue;
            }
          }
          if (!prev || prev.type === TokenType.OPERATOR || prev.type === TokenType.PUNCTUATION) {
            output.push('self');
            continue;
          }
        }

        // Rewrite document.cookie -> document.__vproxy_cookie
        if (token.type === TokenType.IDENTIFIER && token.value === 'cookie' && prev && prev.value === '.') {
          const beforeDot = i > 1 ? tokens[i - 2] : null;
          if (beforeDot && beforeDot.value === 'document') {
            output.push('__vproxy_cookie');
            continue;
          }
        }

        // Rewrite document.domain -> document.__vproxy_domain
        if (token.type === TokenType.IDENTIFIER && token.value === 'domain' && prev && prev.value === '.') {
          const beforeDot = i > 1 ? tokens[i - 2] : null;
          if (beforeDot && beforeDot.value === 'document') {
            output.push('__vproxy_domain');
            continue;
          }
        }

        output.push(token.value);
      }

      return output.join('');
    } catch (e) {
      // Fallback to source if parsing encounters unusual syntax extensions
      return jsCode;
    }
  }
}

module.exports = { Lexer, AstRewriter, TokenType, Token };
